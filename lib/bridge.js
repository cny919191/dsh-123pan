// lib/bridge.js — 浏览器侧调用的 HTTP 桥（只允许本机回环 + POST）
//
// 客户端 UI 通过 /api/dsh-123pan/* 触发核心命令；这里做统一的门禁、
// 请求体大小限制与错误整形，避免 UI 直接拼 shell 参数。

import fs from 'node:fs';
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
      const file = String(body?.file ?? '').trim();
      if (!file) return { ok: false, code: -1, message: '缺少本地文件路径' };
      const data = await coreUpload(config(), {
        file,
        parentId: body?.parentId ?? 0,
        name: body?.name,
      });
      return { ok: true, value: data };
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
      const files = Array.isArray(body?.files) ? body.files.map(String).filter(Boolean) : [];
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
      let out = String(body?.out ?? '').trim();
      if (!out) {
        const dir =
          String(body?.dir ?? '').trim() ||
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
  return routes;
}

function path_basename(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}
