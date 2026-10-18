// lib/core.js — 123pan-core.exe 的进程封装与会话管理
//
// 设计要点：
//  * 所有网络与文件 IO 都在 C++ 核心里完成（HTTPS、S3 分片、DPAPI 加密），
//    插件层只负责参数拼装、NDJSON 解析和进度转发。
//  * 核心进程按需启动、用完即退，不常驻，避免占用句柄与内存。
//  * 会话文件路径通过 DSH_123PAN_STORE 传给核心，保证它落在插件可写的位置。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

/** 插件包根目录（含 native/core 与 client.js）。 */
export function packageRoot() {
  return PACKAGE_ROOT;
}

/** DSH 主目录：优先 DSH_HOME，其次 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/**
 * 数据目录：存会话（DPAPI 加密）与备份清单。
 *
 * 选择顺序（选第一个真正可写的，避免在受限环境里"能算路径但写不进去"）：
 *   1. config.storeDir（用户显式指定）
 *   2. $DSH_HOME/dsh-123pan
 *   3. %LOCALAPPDATA%\dsh-123pan
 *   4. 插件包内 .data（最后兜底，只读安装时才会用到）
 */
export function dataDir(config) {
  const custom = config?.storeDir && String(config.storeDir).trim();
  if (custom) return path.resolve(custom);
  const key = config ? JSON.stringify(config.storeDir ?? '') : '';
  if (cachedDir.key === key) return cachedDir.value;

  const candidates = [];
  candidates.push(path.join(dshHome(), 'dsh-123pan'));
  const local = process.env.LOCALAPPDATA;
  if (local && local.trim()) candidates.push(path.join(local.trim(), 'dsh-123pan'));
  const appData = process.env.APPDATA;
  if (appData && appData.trim()) candidates.push(path.join(appData.trim(), 'dsh-123pan'));
  candidates.push(path.join(PACKAGE_ROOT, '.data'));

  let picked = candidates[0];
  for (const dir of candidates) {
    if (isWritableDir(dir)) {
      picked = dir;
      break;
    }
  }
  cachedDir.key = key;
  cachedDir.value = picked;
  return picked;
}

const cachedDir = { key: null, value: null };  // 可变缓存

/** 目录可写探测：不存在则尝试创建，然后写一个探针文件。 */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function sessionPath(config) {
  return path.join(dataDir(config), 'session.dat');
}

export function manifestPath(config) {
  return path.join(dataDir(config), 'backups.json');
}

/**
 * 解析核心 exe 路径。
 * 顺序：config.corePath → 包内 native/core/123pan-core.exe
 */
export function resolveCore(config) {
  const custom = config?.corePath && String(config.corePath).trim();
  if (custom) return path.resolve(custom);
  return path.join(PACKAGE_ROOT, 'native', 'core', '123pan-core.exe');
}

export class CoreError extends Error {
  constructor(message, code = 0, traceId = '') {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.traceId = traceId;
  }
}

/**
 * 运行核心命令。
 *
 * @param {object} opts
 * @param {string[]} opts.args        核心命令与参数（不含 exe 路径）
 * @param {object}  [opts.config]     插件配置
 * @param {(fraction:number, stage:string)=>void} [opts.onProgress]
 * @param {number}  [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>} 核心返回的 data 节点
 */
export function runCore(opts) {
  const { args = [], config, onProgress, timeoutMs = 15 * 60 * 1000, signal } = opts || {};
  const exe = resolveCore(config);
  if (!fs.existsSync(exe)) {
    return Promise.reject(
      new CoreError(
        `找不到 123pan 核心程序：${exe}\n` +
          '请确认插件完整安装（native/core/123pan-core.exe），或在插件配置里用 corePath 指定路径。',
        -1
      )
    );
  }
  const store = sessionPath(config);
  try {
    fs.mkdirSync(path.dirname(store), { recursive: true });
  } catch {
    /* 核心会报更具体的错 */
  }

  // 结果走临时文件而不是管道：
  //   * 管道 stdio 在受限宿主里会直接 spawn EPERM；
  //   * stdio:'ignore' 在 Windows 上会让 CRT 初始化失败（0xc0000142）。
  // 因此把子进程的 stdout/stderr 重定向到文件描述符，再轮询读取。
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const makeTemp = (name) => {
    const candidates = [];
    try {
      candidates.push(os.tmpdir());
    } catch {
      /* ignore */
    }
    try {
      candidates.push(dataDir(config));
    } catch {
      /* ignore */
    }
    candidates.push(PACKAGE_ROOT);
    let lastError;
    for (const dir of candidates) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `dsh-123pan-${suffix}-${name}`);
        fs.writeFileSync(file, '');
        return file;
      } catch (error) {
        lastError = error;
      }
    }
    throw new CoreError(`无法创建临时输出文件：${lastError?.message ?? '没有可写目录'}`, -1);
  };
  let outFile;
  let errFile;
  try {
    outFile = makeTemp('out.ndjson');
    errFile = makeTemp('err.log');
  } catch (error) {
    return Promise.reject(error);
  }

  const env = { ...process.env, DSH_123PAN_STORE: store, ...(opts.env ?? {}) };
  // 会话由 Node 持有：把 token 通过环境变量交给核心，核心不依赖自己能否写盘。
  const sess = opts.session;
  if (sess?.token) {
    env.DSH_123PAN_TOKEN = sess.token;
    if (sess.nickname) env.DSH_123PAN_NICKNAME = sess.nickname;
    if (sess.passport) env.DSH_123PAN_PASSPORT = sess.passport;
    if (sess.expire) env.DSH_123PAN_EXPIRE = sess.expire;
    if (sess.uid) env.DSH_123PAN_UID = String(sess.uid);
  }
  // 关键：始终用 --out 让核心把 NDJSON 写进独立文件。
  // 不能让核心写 stdout —— 当 stdout 被重定向到文件描述符时，
  // CRT 分配的 fd 可能与核心随后 _wfopen 打开的业务文件撞号，
  // 导致下载数据与协议行写进同一个文件（实测会污染下载结果）。
  const argv = [...args, '--ndjson', outFile];

  return new Promise((resolve, reject) => {
    let child;
    let outFd;
    let errFd;
    try {
      outFd = fs.openSync(outFile, 'a');
      errFd = fs.openSync(errFile, 'a');
      child = spawn(exe, argv, {
        env,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        detached: false,
      });
    } catch (error) {
      closeFds();
      cleanupFile();
      reject(new CoreError(`无法启动核心程序：${error?.message ?? error}`, -1));
      return;
    }

    let settled = false;
    let readOffset = 0;
    let pending = '';
    let result = null;
    let poller = null;
    let timer = null;

    function closeFds() {
      for (const fd of [outFd, errFd]) {
        if (fd === undefined) continue;
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      outFd = undefined;
      errFd = undefined;
    }

    function cleanupFile() {
      closeFds();
      for (const file of [outFile, errFile]) {
        try {
          if (file) fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (poller) clearInterval(poller);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      cleanupFile();
      fn(value);
    }

    function consume() {
      let fd;
      try {
        const size = fs.statSync(outFile).size;
        if (size <= readOffset) return;
        fd = fs.openSync(outFile, 'r');
        const buf = Buffer.alloc(size - readOffset);
        fs.readSync(fd, buf, 0, buf.length, readOffset);
        readOffset = size;
        pending += buf.toString('utf8');
      } catch {
        return;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
      let idx;
      while ((idx = pending.indexOf(String.fromCharCode(10))) >= 0) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (line) handleLine(line);
      }
    }

    function handleLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') {
          try {
            onProgress(Number(msg.fraction) || 0, String(msg.stage ?? ''));
          } catch {
            /* 进度回调异常不影响主流程 */
          }
        }
        return;
      }
      if (msg.type === 'result') result = msg;
    }

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(reject, new CoreError('操作已取消', -1));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(reject, new CoreError(`核心命令超时（${Math.round(timeoutMs / 1000)} 秒）`, -1));
      }, timeoutMs);
    }

    // 150ms 轮询足够让进度条顺滑，又不至于空转
    poller = setInterval(consume, 150);

    child.on('error', (error) => {
      finish(reject, new CoreError(`核心进程启动失败：${error?.message ?? error}`, -1));
    });

    child.on('close', (code) => {
      closeFds();
      consume();
      if (pending.trim()) {
        handleLine(pending.trim());
        pending = '';
      }

      // Windows 上子进程刚退出时，重定向文件的大小元数据可能还没刷新：
      // 首次读可能读不到最后一个 result 行。这里最多重试 10 次（25ms 间隔）。
      let attempts = 0;
      const settle = () => {
        if (result && result.ok) {
          finish(resolve, result.data ?? {});
          return;
        }
        if (result && result.ok === false) {
          const err = result.error || {};
          finish(reject, new CoreError(err.message || '核心返回失败', Number(err.code) || 0, err.traceId || ''));
          return;
        }
        if (attempts < 10) {
          attempts++;
          setTimeout(() => {
            consume();
            if (pending.trim()) {
              handleLine(pending.trim());
              pending = '';
            }
            settle();
          }, 25);
          return;
        }
        let detail = '';
        try {
          detail = fs.readFileSync(errFile, 'utf8').trim().slice(-600);
        } catch {
          /* ignore */
        }
        const hint = detail ? '\n' + detail : '';
        finish(reject, new CoreError(`核心进程异常退出（code=${code}），没有返回结果${hint}`, -1));
      };
      settle();
    });
  });
}

// ---------------- 会话持久化 ----------------

/** 用核心的 DPAPI 加密（密钥与当前 Windows 用户绑定）。 */
async function dpapiProtect(config, text) {
  const data = await runCore({ args: ['protect', '--text', text], config, timeoutMs: 30_000 });
  return String(data.blob ?? '');
}

async function dpapiUnprotect(config, blob) {
  const data = await runCore({ args: ['unprotect', '--text', blob], config, timeoutMs: 30_000 });
  return String(data.text ?? '');
}

/** 写会话：DPAPI 密文由核心生成，落盘由 Node 完成。 */
export async function saveSession(config, session) {
  const payload = JSON.stringify({
    token: session.token,
    expire: session.expire ?? '',
    uid: session.uid ?? 0,
    nickname: session.nickname ?? '',
    passport: session.passport ?? '',
    savedAt: new Date().toISOString(),
  });
  const blob = await dpapiProtect(config, payload);
  if (!blob) throw new CoreError('DPAPI 加密失败，无法保存登录态', -11);
  const file = sessionPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, blob, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 读会话；没有或解不开返回 null。 */
export async function loadSession(config) {
  const file = sessionPath(config);
  let blob;
  try {
    blob = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!blob) return null;
  try {
    const text = await dpapiUnprotect(config, blob);
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

/** 清除本地会话。 */
export function clearSession(config) {
  try {
    fs.unlinkSync(sessionPath(config));
    return true;
  } catch {
    return false;
  }
}

// ---------------- 高层 API ----------------

/**
 * 配置里直接给了 API Key（token）时，把它当会话用。
 * 这样不写 session.dat 也能上传/下载，适合 CI、脚本、多账号切换。
 */
function inlineTokenSession(config) {
  const raw = String(config?.apiToken ?? '').trim();
  if (!raw) return null;
  return {
    token: raw.replace(/^Bearer\s+/i, ''),
    nickname: '',
    passport: '',
    expire: '',
    uid: 0,
  };
}

/**
 * 所有业务命令的统一入口：自动带上当前会话。
 * 会话在 Node 侧加密保存，这里解密后通过环境变量交给核心，
 * 核心因此不依赖"自己能不能写用户目录"。
 */
async function runWithSession(config, args, options = {}) {
  const session = (await loadSession(config)) ?? inlineTokenSession(config);
  if (!session) {
    throw new CoreError(
      '未登录：请先在插件设置页登录 123 云盘，或调用 pan123_login / pan123_login_token（也可在配置里填 apiToken）。',
      401
    );
  }
  return runCore({ args, config, session, ...options });
}

export async function coreStatus(config) {
  const stored = await loadSession(config);
  const session = stored ?? inlineTokenSession(config);
  if (!session) {
    return { loggedIn: false, nickname: '', uid: 0, expire: '', spaceUsed: 0, spaceTotal: 0, vip: false };
  }
  const data = await runCore({ args: ['status'], config, session, timeoutMs: 60_000 });
  // 核心里的 status 会顺手刷新 token，这里把新 token 写回会话。
  // 注意：只有「真正落盘的会话」才回写；配置里的 apiToken 是只读的，
  // 不能因为一次 status 就在磁盘上凭空生成 session.dat。
  if (stored && data?.token && data.token !== session.token) {
    try {
      await saveSession(config, {
        ...session,
        token: data.token,
        expire: data.expire || session.expire,
      });
    } catch {
      /* 刷新失败不影响本次结果 */
    }
  }
  return data;
}

export async function coreLogin(config, { account, password, save = true }) {
  // 密码走环境变量而不是命令行：命令行会出现在进程列表里，环境变量只对该子进程可见。
  const data = await runCore({
    args: ['login', '--account', String(account)],
    config,
    env: { DSH_123PAN_PASSWORD: String(password) },
    timeoutMs: 90_000,
  });
  if (save) {
    await saveSession(config, data);
    data.saved = true;
    data.sessionPath = sessionPath(config);
  }
  return data;
}

/**
 * 用已有的 API Key / JWT 直接登录（不需要账号密码）。
 *
 * token 就是客户端登录后拿到的那串 JWT，可以带 "Bearer " 前缀。
 * 先调一次 status 验证它还能用，通过了才落盘，避免把坏 token 存成会话。
 */
export async function coreLoginWithToken(config, {
  token,
  nickname = '',
  passport = '',
  expire = '',
  uid = 0,
  save = true,
} = {}) {
  const clean = String(token ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!clean) throw new CoreError('API Key / token 不能为空', -1);
  if (clean.length < 20) throw new CoreError('API Key / token 长度异常，请检查是否复制完整', -1);

  const probe = { token: clean, nickname, passport, expire, uid: Number(uid) || 0 };
  const data = await runCore({ args: ['status'], config, session: probe, timeoutMs: 60_000 });
  if (!data?.loggedIn) throw new CoreError('token 无效或已过期', 401);

  const merged = {
    token: data.token || clean,
    nickname: data.nickname || nickname,
    passport: data.passport || passport,
    expire: data.expire || expire,
    uid: Number(data.uid) || Number(uid) || 0,
  };
  if (save) {
    await saveSession(config, merged);
    data.saved = true;
    data.sessionPath = sessionPath(config);
  }
  return { ...data, ...merged };
}


export async function coreLogout(config) {
  const cleared = clearSession(config);
  return { cleared };
}

export async function coreList(config, options = {}) {
  const args = ['list'];
  if (options.parentId !== undefined && options.parentId !== null) {
    args.push('--parent', String(options.parentId));
  }
  if (options.limit) args.push('--limit', String(options.limit));
  if (options.next) args.push('--next', String(options.next));
  if (options.trashed) args.push('--trashed');
  if (options.search) args.push('--search', String(options.search));
  return runWithSession(config, args, { timeoutMs: 120_000 });
}

export async function coreMkdir(config, { name, parentId = 0 }) {
  return runWithSession(config, ['mkdir', '--name', String(name), '--parent', String(parentId)], {
    timeoutMs: 60_000,
  });
}

export async function coreUpload(config, { file, parentId = 0, name, onProgress }) {
  const args = ['upload', '--file', path.resolve(file), '--parent', String(parentId)];
  if (name) args.push('--name', String(name));
  return runWithSession(config, args, { onProgress, timeoutMs: 60 * 60 * 1000 });
}

export async function coreDownload(config, { fileId, out, onProgress }) {
  return runWithSession(config, ['download', '--id', String(fileId), '--out', path.resolve(out)], {
    onProgress,
    timeoutMs: 60 * 60 * 1000,
  });
}

export async function coreUrl(config, { fileId }) {
  return runWithSession(config, ['url', '--id', String(fileId)], { timeoutMs: 60_000 });
}

export async function coreRename(config, { fileId, name }) {
  return runWithSession(config, ['rename', '--id', String(fileId), '--name', String(name)], {
    timeoutMs: 60_000,
  });
}

export async function coreMove(config, { fileIds, parentId }) {
  return runWithSession(config, ['move', '--ids', fileIds.join(','), '--parent', String(parentId)], {
    timeoutMs: 60_000,
  });
}

export async function coreTrash(config, { fileIds }) {
  return runWithSession(config, ['trash', '--ids', fileIds.join(',')], { timeoutMs: 60_000 });
}

export async function corePurge(config, { fileIds }) {
  return runWithSession(config, ['purge', '--ids', fileIds.join(',')], { timeoutMs: 60_000 });
}

export async function coreVersion(config) {
  return runCore({ args: ['version'], config, timeoutMs: 30_000 });
}
