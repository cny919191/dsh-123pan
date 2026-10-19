// lib/bridge.js — 浏览器侧调用的 HTTP 桥（只允许本机回环 + POST）
//
// 客户端 UI 通过 /api/dsh-123pan/* 触发核心命令；这里做统一的门禁、
// 请求体大小限制与错误整形，避免 UI 直接拼 shell 参数。

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import {
  CoreError,
  coreDownload,
  coreList,
  coreLogin,
  coreLoginWithToken,
  coreLogout,
  coreMkdir,
  coreMove,
  corePurge,
  coreRename,
  coreStatus,
  coreTrash,
  coreUpload,
  coreUrl,
  coreVersion,
  dataDir,
  resolveCore,
  sessionPath,
} from './core.js';
import {
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_GLOBS,
  forgetBackup,
  listBackupRecords,
  readBackupRecord,
  runBackup,
  scanWorkspace,
} from './backup.js';

const PREFIX = '/api/dsh-123pan';
// 普通 JSON 请求 1MB；拖拽上传走 base64，单独放宽（默认 200MB 文件 -> 约 267MB）
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 320 * 1024 * 1024;

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * 清洗用户粘贴的本地路径。
 * 在资源管理器里「复制文件地址」拿到的是带引号的：
 *   "C:\Users\znm11\Desktop\tzh.txt"
 * 中文输入法还可能给出全角引号 “ ”。这里把成对的外层引号全部剥掉。
 */
function cleanLocalPath(value) {
  let s = String(value ?? '').trim();
  if (!s) return '';
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
    ['`', '`'],
    ['\u300c', '\u300d'],
    ['\u3010', '\u3011'],
  ];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const [a, b] of pairs) {
      if (s.length >= 2 && s.startsWith(a) && s.endsWith(b)) {
        s = s.slice(a.length, s.length - b.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** 同名文件自动加 (1)(2)，避免覆盖 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return target;
}

// ---------------- 在线预览 ----------------
//
// 123 云盘直链会 302 跳到 CDN，响应头带 Access-Control-Allow-Origin:* 且支持 Range，
// 但 Content-Type 一律是 application/octet-stream：
//   * <img> 会嗅探，直链可用；
//   * <video> 依赖正确 MIME 且要能拖进度 —— 所以统一走本机同源代理。
const PREVIEW_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/plain', '.markdown': 'text/plain', '.log': 'text/plain',
  '.json': 'text/plain', '.js': 'text/plain', '.ts': 'text/plain', '.mjs': 'text/plain',
  '.css': 'text/plain', '.html': 'text/plain', '.htm': 'text/plain', '.xml': 'text/plain',
  '.yml': 'text/plain', '.yaml': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain',
  '.csv': 'text/plain', '.tsv': 'text/plain', '.py': 'text/plain', '.c': 'text/plain',
  '.h': 'text/plain', '.cpp': 'text/plain', '.hpp': 'text/plain', '.java': 'text/plain',
  '.cs': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain', '.sh': 'text/plain',
  '.bat': 'text/plain', '.ps1': 'text/plain', '.sql': 'text/plain', '.toml': 'text/plain',
  '.lrc': 'text/plain', '.srt': 'text/plain', '.vtt': 'text/plain',
};

/** 按扩展名判类型：text / image / video / audio / pdf / other */
function previewKind(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  const mime = PREVIEW_MIME[ext];
  if (!mime) return { kind: 'other', mime: 'application/octet-stream' };
  if (mime.startsWith('text/')) return { kind: 'text', mime };
  if (mime.startsWith('image/')) return { kind: 'image', mime };
  if (mime.startsWith('video/')) return { kind: 'video', mime };
  if (mime.startsWith('audio/')) return { kind: 'audio', mime };
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  return { kind: 'other', mime };
}

/** 打开远端流，自动跟随最多 4 次 302（123 的直链会跳到 CDN 域名）。 */
function openStream(url, headers, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`无效的直链: ${url}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers }, (resp) => {
      const code = resp.statusCode ?? 0;
      const location = resp.headers?.location;
      if (code >= 300 && code < 400 && location && depth < 4) {
        resp.resume();
        resolve(openStream(new URL(location, url).toString(), headers, depth + 1));
        return;
      }
      resolve(resp);
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('预览请求超时')));
  });
}

/** 文本解码：先严格 UTF-8，失败退 GBK（中文 Windows 常见），最后 latin1 兜底 */
function decodeTextBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    /* fallthrough */
  }
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    /* fallthrough */
  }
  return buf.toString('latin1');
}

function toErrorPayload(error) {
  if (error instanceof CoreError) {
    const text = String(error.message ?? '').trim();
    return {
      ok: false,
      code: error.code || 0,
      // 核心偶尔会返回空 message（例如底层 HTTP 异常），这里必须兜底成可读文案，
      // 否则界面上会出现"一条红条但没有文字"的情况。
      message: text || `操作失败（code ${error.code || 'unknown'}）`,
      traceId: error.traceId || undefined,
    };
  }
  const text = String(error?.message ?? '').trim();
  return { ok: false, code: -1, message: text || `操作失败：${String(error)}` };
}

/**
 * 构造路由表。每个 handler 收到 (body, req) 并返回可 JSON 化的值或抛错。
 */
export function createRoutes({ config, logger, getWorkspaceRoot, getSessionCwds }) {
  // 直链缓存：视频拖动进度会连发多个 Range 请求，每个都去要一次签名 URL 太浪费
  const urlCache = new Map();
  const URL_TTL_MS = 15 * 60 * 1000;
  async function directUrlOf(fileId) {
    const hit = urlCache.get(fileId);
    if (hit && Date.now() - hit.at < URL_TTL_MS) return hit.url;
    const data = await coreUrl(config(), { fileId });
    if (!data?.url) throw new CoreError('未能获取直链', -1);
    urlCache.set(fileId, { url: data.url, at: Date.now() });
    return data.url;
  }

  // 异步上传任务表：前端轮询拿「已传 / 总计」进度
  const uploadTasks = new Map();
  const UPLOAD_TASK_TTL_MS = 10 * 60 * 1000;
  const newTaskId = () => `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  function pruneTasks() {
    const now = Date.now();
    for (const [id, t] of uploadTasks) {
      if (t.state !== 'running' && now - t.finishedAt > UPLOAD_TASK_TTL_MS) uploadTasks.delete(id);
    }
  }

  const handlers = {
    async status() {
      const core = resolveCore(config());
      const session = sessionPath(config());
      let info = null;
      let error = null;
      try {
        info = await coreStatus(config());
      } catch (err) {
        error = toErrorPayload(err);
      }
      return {
        ok: true,
        value: {
          corePath: core,
          coreExists: true,
          sessionPath: session,
          dataDir: dataDir(config()),
          workspaceRoot: getWorkspaceRoot(),
          loggedIn: Boolean(info?.loggedIn),
          account: info
            ? {
                uid: info.uid,
                nickname: info.nickname,
                passport: info.passport,
                expire: info.expire,
                vip: info.vip,
                spaceUsed: info.spaceUsed,
                spaceTotal: info.spaceTotal,
              }
            : null,
          error,
        },
      };
    },

    async login(body) {
      const account = String(body?.account ?? '').trim();
      const password = String(body?.password ?? '');
      if (!account || !password) return { ok: false, code: -1, message: '请填写账号和密码' };
      const result = await coreLogin(config(), { account, password, save: true });
      return {
        ok: true,
        value: {
          uid: result.uid,
          nickname: result.nickname,
          expire: result.expire,
          spaceUsed: result.spaceUsed,
          spaceTotal: result.spaceTotal,
          vip: result.vip,
        },
      };
    },

    async logout() {
      const result = await coreLogout(config());
      return { ok: true, value: result };
    },

    /** 用 API Key / token 直接登录（设置页「粘贴 API Key」走这里）。 */
    async loginToken(body) {
      const token = String(body?.token ?? '').trim();
      if (!token) return { ok: false, code: -1, message: '请填写 API Key / token' };
      const result = await coreLoginWithToken(config(), {
        token,
        nickname: String(body?.nickname ?? '').trim(),
        save: body?.save !== false,
      });
      return {
        ok: true,
        value: {
          uid: result.uid,
          nickname: result.nickname,
          passport: result.passport,
          expire: result.expire,
          spaceUsed: result.spaceUsed,
          spaceTotal: result.spaceTotal,
          vip: result.vip,
        },
      };
    },

    async list(body) {
      const data = await coreList(config(), {
        parentId: body?.parentId ?? 0,
        limit: body?.limit ?? 100,
        next: body?.next,
        trashed: Boolean(body?.trashed),
        search: body?.search,
      });
      return { ok: true, value: data };
    },

    async mkdir(body) {
      const name = String(body?.name ?? '').trim();
      if (!name) return { ok: false, code: -1, message: '目录名不能为空' };
      const data = await coreMkdir(config(), { name, parentId: body?.parentId ?? 0 });
      return { ok: true, value: data };
    },

    async upload(body) {
      const file = cleanLocalPath(body?.file);
      if (!file) return { ok: false, code: -1, message: '缺少本地文件路径' };
      if (!fs.existsSync(file)) return { ok: false, code: -1, message: `本地文件不存在：${file}` };
      const data = await coreUpload(config(), {
        file,
        parentId: body?.parentId ?? 0,
        name: body?.name,
      });
      return { ok: true, value: data };
    },

    /**
     * 启动一个带进度的上传任务，立刻返回 taskId。
     * 上传本身在宿主里跑，前端用 uploadState 轮询「已传 / 总计」。
     */
    async uploadStart(body) {
      const file = cleanLocalPath(body?.file);
      if (!file) return { ok: false, code: -1, message: '缺少本地文件路径' };
      if (!fs.existsSync(file)) return { ok: false, code: -1, message: `本地文件不存在：${file}` };
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return { ok: false, code: -1, message: '这是个目录，请填具体文件路径' };

      pruneTasks();
      const taskId = newTaskId();
      const task = {
        state: 'running',
        fraction: 0,
        stage: '准备上传',
        total: stat.size,
        name: body?.name ? String(body.name) : path.basename(file),
        result: null,
        error: null,
        finishedAt: 0,
      };
      uploadTasks.set(taskId, task);

      coreUpload(config(), {
        file,
        parentId: Number(body?.parentId) || 0,
        name: body?.name,
        // runCore 的回调是位置参数 (fraction, stage)，不是对象
        onProgress: (fraction, stage) => {
          task.fraction = Math.max(0, Math.min(1, Number(fraction) || 0));
          if (stage) task.stage = String(stage);
        },
      })
        .then((value) => {
          task.state = 'done';
          task.fraction = 1;
          task.stage = '完成';
          task.result = value;
        })
        .catch((error) => {
          task.state = 'error';
          task.error = String(error?.message ?? '上传失败');
        })
        .finally(() => {
          task.finishedAt = Date.now();
        });

      return { ok: true, value: { taskId, name: task.name, total: task.total, stage: task.stage } };
    },

    /** 查询上传任务进度；bytes/total 就是前端要显示的「已传 / 总计」。 */
    async uploadState(body) {
      const id = String(body?.taskId ?? '');
      const t = uploadTasks.get(id);
      if (!t) return { ok: false, code: -1, message: '上传任务不存在或已过期' };
      return {
        ok: true,
        value: {
          state: t.state,
          fraction: t.fraction,
          stage: t.stage,
          bytes: Math.round(t.total * t.fraction),
          total: t.total,
          name: t.name,
          result: t.result,
          error: t.error,
        },
      };
    },

    /**
     * 接收浏览器拖进来的文件：客户端把 File 读成 base64 发过来，
     * 这里落成临时文件再交给核心上传（核心只认本地路径）。
     */
    async uploadBytes(body) {
      const name = String(body?.name ?? '').trim();
      const dataB64 = String(body?.data ?? '');
      if (!name) return { ok: false, code: -1, message: '缺少文件名' };
      if (!dataB64) return { ok: false, code: -1, message: '文件内容为空' };
      let buf;
      try {
        buf = Buffer.from(dataB64, 'base64');
      } catch {
        return { ok: false, code: -1, message: '文件内容不是合法 base64' };
      }
      if (buf.length === 0) return { ok: false, code: -1, message: '文件内容为空' };
      const limit = Number(config()?.maxFileBytes) > 0 ? Number(config()?.maxFileBytes) : 200 * 1024 * 1024;
      if (buf.length > limit) {
        return { ok: false, code: -1, message: `文件超过上限 ${Math.round(limit / 1024 / 1024)}MB` };
      }

      const tmpDir = path.join(dataDir(config()), 'incoming');
      fs.mkdirSync(tmpDir, { recursive: true });
      const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'upload.bin';
      const tmpFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
      fs.writeFileSync(tmpFile, buf);
      try {
        const value = await coreUpload(config(), {
          file: tmpFile,
          parentId: Number(body?.parentId) || 0,
          name: safe,
        });
        return { ok: true, value: { ...value, name: safe, bytes: buf.length } };
      } finally {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }
    },

    /** 批量按本地路径上传（AI / 脚本友好）：一次调用传多个文件。 */
    async uploadBatch(body) {
      const files = Array.isArray(body?.files) ? body.files.map(cleanLocalPath).filter(Boolean) : [];
      if (files.length === 0) return { ok: false, code: -1, message: '缺少 files 数组' };
      const parentId = Number(body?.parentId) || 0;
      const results = [];
      for (const file of files) {
        try {
          const value = await coreUpload(config(), { file, parentId });
          results.push({ file, ok: true, name: value.name, fileId: value.fileId, bytes: value.size, reused: !!value.reused });
        } catch (error) {
          const payload = toErrorPayload(error);
          results.push({ file, ok: false, message: payload.message });
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      return {
        ok: succeeded > 0,
        value: { total: results.length, succeeded, failed: results.length - succeeded, results },
        message: succeeded === results.length ? undefined : `${results.length - succeeded} 个文件失败`,
      };
    },

    async download(body) {
      const fileId = Number(body?.fileId);
      if (!fileId) return { ok: false, code: -1, message: '缺少文件 ID' };
      const name = String(body?.name ?? '').trim() || `file-${fileId}`;

      // 保存目录优先级：显式 out > 显式 dir > 插件配置 downloadDir > 工作区根目录
      let out = cleanLocalPath(body?.out);
      if (!out) {
        const dir =
          cleanLocalPath(body?.dir) ||
          String(config()?.downloadDir ?? '').trim() ||
          String(body?.workspaceRoot ?? '').trim() ||
          getWorkspaceRoot();
        if (!dir) return { ok: false, code: -1, message: '缺少保存目录：请指定下载目录' };
        fs.mkdirSync(dir, { recursive: true });
        out = uniquePath(path.join(dir, name));
      } else {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        out = uniquePath(out);
      }

      /**
       * 核心 exe 位于工作区，通常带 Low 完整性标签：
       * 它能写工作区，却写不了 %TEMP%、.dsh、桌面这类 Medium 目录
       * （表现为 cannot open output file）。而 Node 侧两者都能写。
       *
       * 策略：先让核心直连目标；
       * 若报"打不开输出文件"，退到工作区暂存，再由 Node 搬到目标。
       */
      try {
        const data = await coreDownload(config(), { fileId, out });
        return { ok: true, value: { ...data, path: out, bytes: fs.statSync(out).size } };
      } catch (error) {
        const text = String(error?.message ?? '');
        if (!text.includes('cannot open output file')) throw error;

        const stagingRoot = getWorkspaceRoot();
        if (!stagingRoot) {
          throw new Error(`无法写入 ${out}：目标目录不可写，且没有可用的暂存目录`);
        }
        const stagingDir = path.join(stagingRoot, '.dsh-123pan-staging');
        fs.mkdirSync(stagingDir, { recursive: true });
        const staging = path.join(stagingDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(out)}`);
        try {
          const data = await coreDownload(config(), { fileId, out: staging });
          fs.copyFileSync(staging, out);
          return { ok: true, value: { ...data, path: out, bytes: fs.statSync(out).size } };
        } catch (inner) {
          const innerText = String(inner?.message ?? '');
          if (innerText.includes('cannot open output file')) {
            throw new Error(`无法写入 ${out}：目标目录不可写（权限或 Windows 完整性级别限制），请换一个目录`);
          }
          throw inner;
        } finally {
          try {
            fs.unlinkSync(staging);
          } catch {
            /* ignore */
          }
        }
      }
    },

    async url(body) {
      const fileId = Number(body?.fileId);
      if (!fileId) return { ok: false, code: -1, message: '缺少文件 ID' };
      const data = await coreUrl(config(), { fileId });
      return { ok: true, value: data };
    },

    /**
     * 在线预览：
     *   text  -> 由宿主直接拉取并解码，回传文本
     *   其它  -> 回传同源 mediaUrl（交给 /media 代理，保证 MIME 与 Range）
     */
    async preview(body) {
      const fileId = Number(body?.fileId);
      if (!fileId) return { ok: false, code: -1, message: '缺少文件 ID' };
      const name = String(body?.name ?? '').trim() || `file-${fileId}`;
      const size = Number(body?.size) || 0;
      const { kind, mime } = previewKind(name);

      const mediaUrl = `${PREFIX}/media?id=${encodeURIComponent(fileId)}&name=${encodeURIComponent(name)}`;

      if (kind !== 'text') {
        // 视频/音频优先用 CDN 直链 + 显式 type：
        // <source type="video/mp4"> 让浏览器按声明的 MIME 解码，不必依赖响应头，
        // 而且直连 CDN 的 Range 由 CDN 自己处理，拖动进度最稳。
        // 直链失效时客户端会回退到同源代理 mediaUrl。
        let directUrl = '';
        try {
          directUrl = await directUrlOf(fileId);
        } catch {
          /* 直链拿不到就只用代理 */
        }
        return { ok: true, value: { kind, mime, name, size, mediaUrl, directUrl } };
      }

      const TEXT_LIMIT = 2 * 1024 * 1024;
      if (size > TEXT_LIMIT) {
        return {
          ok: false,
          code: -1,
          message: `文本文件超过 ${Math.round(TEXT_LIMIT / 1024 / 1024)} MB，预览已省略，请下载查看`,
        };
      }

      const url = await directUrlOf(fileId);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`读取文件失败：HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > TEXT_LIMIT) {
        return {
          ok: false,
          code: -1,
          message: `文本文件超过 ${Math.round(TEXT_LIMIT / 1024 / 1024)} MB，预览已省略，请下载查看`,
        };
      }
      const text = decodeTextBuffer(buf);
      return {
        ok: true,
        value: { kind: 'text', mime, name, size: buf.length, text, lines: text.split('\n').length },
      };
    },

    async rename(body) {
      const fileId = Number(body?.fileId);
      const name = String(body?.name ?? '').trim();
      if (!fileId || !name) return { ok: false, code: -1, message: '缺少文件 ID 或新名称' };
      const data = await coreRename(config(), { fileId, name });
      return { ok: true, value: data };
    },

    async move(body) {
      const fileIds = Array.isArray(body?.fileIds) ? body.fileIds.map(Number).filter(Boolean) : [];
      if (fileIds.length === 0) return { ok: false, code: -1, message: '缺少文件 ID' };
      const data = await coreMove(config(), { fileIds, parentId: Number(body?.parentId) || 0 });
      return { ok: true, value: data };
    },

    async trash(body) {
      const fileIds = Array.isArray(body?.fileIds) ? body.fileIds.map(Number).filter(Boolean) : [];
      if (fileIds.length === 0) return { ok: false, code: -1, message: '缺少文件 ID' };
      const data = await coreTrash(config(), { fileIds });
      return { ok: true, value: data };
    },

    async purge(body) {
      const fileIds = Array.isArray(body?.fileIds) ? body.fileIds.map(Number).filter(Boolean) : [];
      if (fileIds.length === 0) return { ok: false, code: -1, message: '缺少文件 ID' };
      const data = await corePurge(config(), { fileIds });
      return { ok: true, value: data };
    },

    async version() {
      const data = await coreVersion(config());
      return { ok: true, value: data };
    },

    // ---- 备份 ----
    /** 诊断：当前解析出的工作区、会话 cwd、下载目录，便于排查路径问题。 */
    async diag() {
      return {
        ok: true,
        value: {
          workspaceRoot: getWorkspaceRoot(),
          downloadDir: String(config()?.downloadDir ?? '').trim() || null,
          dataDir: dataDir(config()),
          corePath: resolveCore(config()),
          sessionPath: sessionPath(config()),
          cwd: process.cwd(),
          tempDir: os.tmpdir(),
          sessionCwds: typeof getSessionCwds === 'function' ? getSessionCwds() : [],
        },
      };
    },

    async scan(body) {
      const root = String(body?.workspaceRoot ?? '').trim() || getWorkspaceRoot();
      if (!root) return { ok: false, code: -1, message: '缺少工作区目录' };
      const scan = scanWorkspace(root, {
        ignoreDirs: config()?.ignoreDirs,
        ignoreGlobs: config()?.ignoreGlobs,
        maxFileBytes: config()?.maxFileBytes,
        maxFiles: config()?.maxFiles,
      });
      const remoteDir = String(body?.remoteDir ?? '').trim() || config()?.defaultRemoteDir || '';
      const record = readBackupRecord(config(), root, remoteDir || `dsh-backup/${path_basename(root)}`);
      const known = record?.files ?? {};
      let unchanged = 0;
      const pending = [];
      for (const file of scan.files) {
        const prev = known[file.rel];
        if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) unchanged++;
        else pending.push({ rel: file.rel, size: file.size });
      }
      return {
        ok: true,
        value: {
          workspaceRoot: root,
          remoteDir: remoteDir || `dsh-backup/${path_basename(root)}`,
          files: scan.files.length,
          bytes: scan.files.reduce((s, f) => s + f.size, 0),
          pending,
          unchanged,
          skipped: scan.skipped,
          truncated: scan.truncated,
          lastRun: record?.lastRun ?? null,
        },
      };
    },

    async backup(body) {
      const root = String(body?.workspaceRoot ?? '').trim() || getWorkspaceRoot();
      if (!root) return { ok: false, code: -1, message: '缺少工作区目录' };
      const summary = await runBackup({
        workspaceRoot: root,
        config: config(),
        remoteDir: body?.remoteDir,
        dryRun: Boolean(body?.dryRun),
        onEvent: (evt) => {
          try {
            logger?.debug?.(`123pan backup: ${evt.type} ${evt.rel ?? evt.message ?? ''}`);
          } catch {
            /* ignore */
          }
        },
      });
      return { ok: true, value: summary };
    },

    async backups() {
      return {
        ok: true,
        value: {
          records: listBackupRecords(config()),
          defaultRemoteDir: config()?.defaultRemoteDir ?? '',
          ignoreDirs: config()?.ignoreDirs ?? DEFAULT_IGNORE_DIRS,
          ignoreGlobs: config()?.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS,
        },
      };
    },

    async forget(body) {
      const root = String(body?.workspaceRoot ?? '').trim() || getWorkspaceRoot();
      const remoteDir = String(body?.remoteDir ?? '').trim() || config()?.defaultRemoteDir || `dsh-backup/${path_basename(root)}`;
      const removed = forgetBackup(config(), root, remoteDir);
      return { ok: true, value: { removed } };
    },
  };

  const routes = [];
  for (const [name, handler] of Object.entries(handlers)) {
    routes.push({
      kind: 'exact',
      path: `${PREFIX}/${name}`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, code: 403, message: '仅允许本机请求' });
          return;
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, code: 405, message: '只接受 POST' });
          return;
        }
        const limit = req.url?.includes('/uploadBytes') ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
        const body = await readJsonBody(req, limit);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 400, message: '请求体过大或不是合法 JSON' });
          return;
        }
        try {
          const result = await handler(body ?? {});
          writeJson(res, 200, result);
        } catch (error) {
          writeJson(res, 200, toErrorPayload(error));
        }
      },
    });
  }

  // 同源媒体代理：修正 Content-Type、转发 Range，供 <img>/<video>/<audio>/<embed> 使用。
  // 只有这一条路由接受 GET（浏览器对 <video> 的原生请求不会是 POST）。
  routes.push({
    kind: 'exact',
    path: `${PREFIX}/media`,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('仅允许本机请求');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }

      let parsed;
      try {
        parsed = new URL(req.url, 'http://127.0.0.1');
      } catch {
        res.writeHead(400);
        res.end('bad url');
        return;
      }
      const fileId = Number(parsed.searchParams.get('id'));
      const name = parsed.searchParams.get('name') || '';
      if (!fileId) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('missing id');
        return;
      }

      try {
        const target = await directUrlOf(fileId);
        const mime = previewKind(name).mime;
        const upstreamHeaders = { 'user-agent': 'dsh-123pan-preview/1.2' };
        if (req.headers.range) upstreamHeaders.range = String(req.headers.range);

        const upstream = await openStream(target, upstreamHeaders);
        const status = upstream.statusCode ?? 200;
        const h = upstream.headers;
        const out = {
          'content-type': mime,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=300',
          // 预览的是远端内容，别让它在页面上下文里执行脚本
          'x-content-type-options': 'nosniff',
        };
        if (h['content-length']) out['content-length'] = String(h['content-length']);
        if (h['content-range']) out['content-range'] = String(h['content-range']);
        if (h['etag']) out['etag'] = String(h['etag']);
        if (h['last-modified']) out['last-modified'] = String(h['last-modified']);

        res.writeHead(status, out);
        if (req.method === 'HEAD') {
          upstream.resume();
          res.end();
          return;
        }
        req.on('close', () => upstream.destroy());
        upstream.pipe(res);
      } catch (error) {
        const message = String(error?.message ?? '代理失败');
        logger?.debug?.(`123pan preview: ${message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end(message);
      }
    },
  });

  return routes;
}

function path_basename(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
