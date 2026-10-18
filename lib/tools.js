// lib/tools.js — 暴露给 agent 的 123 云盘工具
//
// 与 UI 共用 lib/core.js 的同一套操作，避免两套逻辑漂移。
// 每个工具都返回 { ok, ... } 结构，失败时把原因写进结果而不是抛异常，
// 这样 agent 能看到失败原因并自行决定重试或换路径。

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
  dataDir,
  resolveCore,
} from './core.js';
import { runBackup, scanWorkspace, listBackupRecords } from './backup.js';

function fail(error) {
  if (error instanceof CoreError) {
    return { ok: false, code: error.code || 0, message: error.message };
  }
  return { ok: false, code: -1, message: error?.message ? String(error.message) : String(error) };
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(2)} ${units[i]}`;
}

/**
 * 注册全部工具。
 * @param {object} ctx cordis 上下文
 * @param {object} options { config: () => config, defineTool, logger }
 */
export function registerTools(ctx, { config, defineTool, logger }) {
  const disposers = [];

  // ---- 登录 / 状态 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_login',
        description:
          'Log in to 123 Cloud Drive (123云盘) with a phone number/email and password, and persist the session so later pan123_* tools work. Use this when pan123_status reports not logged in, or the user asks to connect their 123pan account.',
        parameters: {
          account: {
            type: 'string',
            description: 'Phone number or email of the 123pan account.',
          },
          password: {
            type: 'string',
            description: 'Account password. It is sent once to the login endpoint and never stored; only the returned JWT is kept (DPAPI-encrypted).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              nickname: { type: 'string' },
              uid: { type: 'number' },
              expire: { type: 'string' },
              spaceUsed: { type: 'number' },
              spaceTotal: { type: 'number' },
              vip: { type: 'boolean' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          try {
            const data = await coreLogin(config(), {
              account: String(args.account ?? '').trim(),
              password: String(args.password ?? ''),
              save: true,
            });
            return {
              ok: true,
              message: `已登录 ${data.nickname || data.passport || ''}（uid ${data.uid}），token 有效期至 ${data.expire || '未知'}`,
              nickname: String(data.nickname ?? ''),
              uid: Number(data.uid) || 0,
              expire: String(data.expire ?? ''),
              spaceUsed: Number(data.spaceUsed) || 0,
              spaceTotal: Number(data.spaceTotal) || 0,
              vip: Boolean(data.vip),
            };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  // ---- 用 API Key / token 直接登录（不用账号密码）----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_login_token',
        description:
          'Log in to 123 Cloud Drive (123云盘) with an existing API key / JWT token instead of account+password. The token is validated once, then stored DPAPI-encrypted so pan123_* tools work without re-supplying it.',
        parameters: {
          token: {
            type: 'string',
            description:
              'The 123pan JWT. Either the raw token or "Bearer <token>". Get it from the desktop client log (Token:Bearer eyJ...) or reuse a previously exported one.',
          },
          nickname: {
            type: 'string',
            description: 'Optional display name stored alongside the token (cosmetic only).',
          },
          save: {
            type: 'boolean',
            description: 'Persist the token to the local encrypted session (default true).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              nickname: { type: 'string' },
              uid: { type: 'number' },
              expire: { type: 'string' },
              spaceUsed: { type: 'number' },
              spaceTotal: { type: 'number' },
              vip: { type: 'boolean' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          try {
            const data = await coreLoginWithToken(config(), {
              token: String(args.token ?? ''),
              nickname: String(args.nickname ?? '').trim(),
              save: args.save !== false,
            });
            return {
              ok: true,
              message: `已用 API Key 登录 ${data.nickname || data.passport || ''}（uid ${data.uid}），token 有效期至 ${data.expire || '未知'}`,
              nickname: String(data.nickname ?? ''),
              uid: Number(data.uid) || 0,
              expire: String(data.expire ?? ''),
              spaceUsed: Number(data.spaceUsed) || 0,
              spaceTotal: Number(data.spaceTotal) || 0,
              vip: Boolean(data.vip),
            };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_status',
        description:
          'Check whether the 123 Cloud Drive (123云盘) session is usable: logged-in account, token expiry, used/total space, and where the core binary and session file live.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              loggedIn: { type: 'boolean' },
              message: { type: 'string' },
              nickname: { type: 'string' },
              uid: { type: 'number' },
              expire: { type: 'string' },
              spaceUsed: { type: 'number' },
              spaceTotal: { type: 'number' },
              spaceUsedText: { type: 'string' },
              spaceTotalText: { type: 'string' },
              vip: { type: 'boolean' },
              corePath: { type: 'string' },
              dataDir: { type: 'string' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute() {
          const corePath = resolveCore(config());
          const dir = dataDir(config());
          try {
            const data = await coreStatus(config());
            return {
              ok: true,
              loggedIn: Boolean(data.loggedIn),
              message: data.loggedIn
                ? `已登录 ${data.nickname || data.passport}（uid ${data.uid}），token 有效期至 ${data.expire}，已用 ${formatBytes(data.spaceUsed)} / ${formatBytes(data.spaceTotal)}`
                : '未登录 123 云盘：请先调用 pan123_login 提供账号密码。',
              nickname: String(data.nickname ?? ''),
              uid: Number(data.uid) || 0,
              expire: String(data.expire ?? ''),
              spaceUsed: Number(data.spaceUsed) || 0,
              spaceTotal: Number(data.spaceTotal) || 0,
              spaceUsedText: formatBytes(data.spaceUsed),
              spaceTotalText: formatBytes(data.spaceTotal),
              vip: Boolean(data.vip),
              corePath,
              dataDir: dir,
            };
          } catch (error) {
            const f = fail(error);
            return {
              ok: false,
              loggedIn: false,
              message: f.message,
              corePath,
              dataDir: dir,
            };
          }
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_logout',
        description: 'Log out of 123 Cloud Drive (123云盘) by deleting the locally stored encrypted session.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute() {
          try {
            await coreLogout(config());
            return { ok: true, message: '已退出登录，本地会话已删除。' };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  // ---- 浏览 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_list',
        description:
          'List files and folders in a 123 Cloud Drive (123云盘) directory. Use parentId 0 for the root. Pass trashed=true to list the recycle bin.',
        parameters: {
          parentId: { type: 'number', description: 'Directory file id; 0 means the drive root.' },
          limit: { type: 'number', description: 'Page size, default 100, max 500.' },
          next: { type: 'string', description: 'Pagination cursor from a previous call (data.next).' },
          trashed: { type: 'boolean', description: 'List the recycle bin instead of a normal directory.' },
          search: { type: 'string', description: 'Optional filename keyword filter.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              total: { type: 'number' },
              next: { type: 'string' },
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    fileId: { type: 'number' },
                    name: { type: 'string' },
                    isDir: { type: 'boolean' },
                    size: { type: 'number' },
                    sizeText: { type: 'string' },
                    updateAt: { type: 'string' },
                  },
                },
              },
            },
          },
          render(args, value) {
            const lines = [value.message];
            for (const e of value.entries ?? []) {
              lines.push(`- ${e.isDir ? '[DIR]' : '     '} ${e.fileId}  ${e.sizeText.padStart(10)}  ${e.name}`);
          }
          if (value.next && value.next !== '-1') lines.push(`(更多：next=${value.next})`);
          return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          try {
            const data = await coreList(config(), {
              parentId: Number(args.parentId) || 0,
              limit: Number(args.limit) || 100,
              next: args.next,
              trashed: Boolean(args.trashed),
              search: args.search,
            });
            const entries = (data.items || []).map((it) => ({
              fileId: Number(it.fileId) || 0,
              name: String(it.name ?? ''),
              isDir: Number(it.type) === 1,
              size: Number(it.size) || 0,
              sizeText: formatBytes(it.size),
              updateAt: String(it.updateAt ?? ''),
            }));
            const dirs = entries.filter((e) => e.isDir).length;
            return {
              ok: true,
              message: `共 ${data.total ?? entries.length} 项（目录 ${dirs}，文件 ${entries.length - dirs}）`,
              total: Number(data.total) || entries.length,
              next: String(data.next ?? ''),
              entries,
            };
          } catch (error) {
            const f = fail(error);
            return { ok: false, message: f.message, total: 0, next: '', entries: [] };
          }
        },
      })
    )
  );

  // ---- 建目录 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_mkdir',
        description: 'Create a folder in 123 Cloud Drive (123云盘).',
        parameters: {
          name: { type: 'string', description: 'New folder name.' },
          parentId: { type: 'number', description: 'Parent directory id; 0 means the drive root.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              fileId: { type: 'number' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          const name = String(args.name ?? '').trim();
          if (!name) return { ok: false, message: '目录名不能为空', fileId: 0 };
          try {
            const data = await coreMkdir(config(), { name, parentId: Number(args.parentId) || 0 });
            return { ok: true, message: `已创建目录 ${name}（id ${data.fileId}）`, fileId: Number(data.fileId) || 0 };
          } catch (error) {
            return { ok: false, message: fail(error).message, fileId: 0 };
          }
        },
      })
    )
  );

  // ---- 上传 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_upload',
        description:
          'Upload one local file to 123 Cloud Drive (123云盘) by its local path — no helper script needed. Handles MD5 instant-upload, 16MB multipart chunks and resume-free single-shot transfer. Call this directly with the path of any file you want to back up; use pan123_backup_workspace to upload a whole workspace incrementally.',
        parameters: {
          file: { type: 'string', description: 'Absolute or workspace-relative path of the local file.' },
          parentId: { type: 'number', description: 'Destination directory id; 0 means the drive root.' },
          name: { type: 'string', description: 'Optional remote filename; defaults to the local basename.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              fileId: { type: 'number' },
              name: { type: 'string' },
              size: { type: 'number' },
              sizeText: { type: 'string' },
              reused: { type: 'boolean' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args, exec) {
          const file = String(args.file ?? '').trim();
          if (!file) return { ok: false, message: '缺少本地文件路径', fileId: 0 };
          const cwd = exec?.cwd || process.cwd();
          const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
          try {
            const data = await coreUpload(config(), {
              file: abs,
              parentId: Number(args.parentId) || 0,
              name: args.name,
            });
            return {
              ok: true,
              message: `${data.reused ? '秒传完成' : '上传完成'}：${data.name}（${formatBytes(data.size)}，id ${data.fileId}）`,
              fileId: Number(data.fileId) || 0,
              name: String(data.name ?? ''),
              size: Number(data.size) || 0,
              sizeText: formatBytes(data.size),
              reused: Boolean(data.reused),
            };
          } catch (error) {
            return { ok: false, message: fail(error).message, fileId: 0 };
          }
        },
      })
    )
  );

  // ---- 下载 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_download',
        description: 'Download a file from 123 Cloud Drive (123云盘) by its file id to a local path.',
        parameters: {
          fileId: { type: 'number', description: 'Cloud file id.' },
          out: { type: 'string', description: 'Local destination path (absolute, or relative to the workspace).' },
          dir: { type: 'string', description: 'Destination directory; defaults to the plugin downloadDir or the workspace root.' },
          name: { type: 'string', description: 'Optional filename to save as; defaults to "file-<id>".' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              path: { type: 'string' },
              bytes: { type: 'number' },
              bytesText: { type: 'string' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args, exec) {
          const fileId = Number(args.fileId) || 0;
          if (!fileId) return { ok: false, message: '缺少文件 id' };
          const cwd = exec?.cwd || process.cwd();
          let out = String(args.out ?? '').trim();
          if (!out) {
            const dir =
              String(args.dir ?? '').trim() ||
              String(config()?.downloadDir ?? '').trim() ||
              cwd;
            // 有名字就用名字，避免全都落成 file-<id>
            const remoteName = String(args.name ?? '').trim().replace(/[\/:*?"<>|]/g, '_');
            out = path.join(dir, remoteName || `file-${fileId}`);
          }
          const abs = path.isAbsolute(out) ? out : path.resolve(cwd, out);
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            // 核心可能带 Low 完整性标签：能写工作区，但写不了 .dsh/桌面/Temp。
            // 先直连目标，失败再走"工作区暂存 + Node 搬运"。
            try {
              await coreDownload(config(), { fileId, out: abs });
            } catch (error) {
              const text = String(error?.message ?? '');
              if (!text.includes('cannot open output file')) throw error;
              const stagingDir = path.join(cwd, '.dsh-123pan-staging');
              fs.mkdirSync(stagingDir, { recursive: true });
              const staging = path.join(stagingDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(abs)}`);
              try {
                await coreDownload(config(), { fileId, out: staging });
                fs.copyFileSync(staging, abs);
              } finally {
                try {
                  fs.unlinkSync(staging);
                } catch {
                  /* ignore */
                }
              }
            }
            const bytes = fs.statSync(abs).size;
            return {
              ok: true,
              message: `下载完成：${abs}（${formatBytes(bytes)}）`,
              path: abs,
              bytes,
              bytesText: formatBytes(bytes),
            };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  // ---- 直链 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_direct_link',
        description:
          'Get a temporary signed direct download URL for a 123 Cloud Drive (123云盘) file. The link expires after a few days.',
        parameters: {
          fileId: { type: 'number', description: 'Cloud file id.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              url: { type: 'string' },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          const fileId = Number(args.fileId) || 0;
          if (!fileId) return { ok: false, message: '缺少文件 id', url: '' };
          try {
            const data = await coreUrl(config(), { fileId });
            return { ok: true, message: `直链（临时有效）：${data.url}`, url: String(data.url ?? '') };
          } catch (error) {
            return { ok: false, message: fail(error).message, url: '' };
          }
        },
      })
    )
  );

  // ---- 重命名 / 移动 / 删除 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_rename',
        description: 'Rename a file or folder in 123 Cloud Drive (123云盘).',
        parameters: {
          fileId: { type: 'number', description: 'Cloud file id.' },
          name: { type: 'string', description: 'New name.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          const fileId = Number(args.fileId) || 0;
          const name = String(args.name ?? '').trim();
          if (!fileId || !name) return { ok: false, message: '缺少文件 id 或新名称' };
          try {
            await coreRename(config(), { fileId, name });
            return { ok: true, message: `已重命名为 ${name}` };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_move',
        description: 'Move files or folders to another 123 Cloud Drive (123云盘) directory.',
        parameters: {
          fileIds: {
            type: 'array',
            description: 'Cloud file ids to move.',
            items: { type: 'number' },
          },
          parentId: { type: 'number', description: 'Destination directory id; 0 means the drive root.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          const fileIds = Array.isArray(args.fileIds) ? args.fileIds.map(Number).filter(Boolean) : [];
          if (fileIds.length === 0) return { ok: false, message: '缺少文件 id' };
          try {
            await coreMove(config(), { fileIds, parentId: Number(args.parentId) || 0 });
            return { ok: true, message: `已移动 ${fileIds.length} 项` };
          } catch (error) {
            return { ok: false, message: fail(error).message };
          }
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_delete',
        description:
          'Delete items in 123 Cloud Drive (123云盘). Default action "trash" moves them to the recycle bin (recoverable); "purge" permanently deletes an item that is already in the recycle bin.',
        parameters: {
          fileIds: {
            type: 'array',
            description: 'Cloud file ids to delete.',
            items: { type: 'number' },
          },
          action: {
            type: 'string',
            enum: ['trash', 'purge'],
            description: 'trash = move to recycle bin (default); purge = permanently delete from the recycle bin.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, message: { type: 'string' }, count: { type: 'number' } },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute(args) {
          const fileIds = Array.isArray(args.fileIds) ? args.fileIds.map(Number).filter(Boolean) : [];
          if (fileIds.length === 0) return { ok: false, message: '缺少文件 id', count: 0 };
          const purge = String(args.action ?? 'trash') === 'purge';
          try {
            const data = purge ? await corePurge(config(), { fileIds }) : await coreTrash(config(), { fileIds });
            return {
              ok: true,
              message: purge ? `已从回收站彻底删除 ${data.count ?? fileIds.length} 项` : `已移入回收站 ${data.count ?? fileIds.length} 项`,
              count: Number(data.count) || fileIds.length,
            };
          } catch (error) {
            return { ok: false, message: fail(error).message, count: 0 };
          }
        },
      })
    )
  );

  // ---- 工作区备份 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_backup_workspace',
        description:
          'Back up the current workspace to 123 Cloud Drive (123云盘) incrementally: scans the workspace (skipping .git, node_modules, caches and files over the size limit), then uploads only new or changed files to the configured remote folder. Use dryRun to preview what would be uploaded.',
        parameters: {
          remoteDir: {
            type: 'string',
            description: 'Remote folder path, e.g. "dsh-backup/my-project". Defaults to the configured defaultRemoteDir or dsh-backup/<workspace name>.',
          },
          dryRun: { type: 'boolean', description: 'Only scan and report what would be uploaded; do not transfer.' },
          workspaceRoot: { type: 'string', description: 'Workspace directory to back up; defaults to the current working directory.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              workspaceRoot: { type: 'string' },
              remoteDir: { type: 'string' },
              scanned: { type: 'number' },
              totalBytesText: { type: 'string' },
              uploaded: { type: 'number' },
              unchanged: { type: 'number' },
              failed: { type: 'number' },
              truncated: { type: 'boolean' },
              pending: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { rel: { type: 'string' }, size: { type: 'number' } },
                },
              },
            },
          },
          render(args, value) {
            const lines = [value.message];
            for (const f of value.pending ?? []) lines.push(`- ${formatBytes(f.size).padStart(10)}  ${f.rel}`);
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args, exec) {
          const cwd = exec?.cwd || process.cwd();
          const root = String(args.workspaceRoot ?? '').trim() || cwd;
          try {
            const summary = await runBackup({
              workspaceRoot: root,
              config: config(),
              remoteDir: args.remoteDir,
              dryRun: Boolean(args.dryRun),
              onEvent: (evt) => {
                try {
                  logger?.debug?.(`123pan backup: ${evt.type} ${evt.rel ?? evt.message ?? ''}`);
                } catch {
                  /* ignore */
                }
              },
            });
            if (summary.dryRun) {
              return {
                ok: true,
                message:
                  `预演：工作区 ${summary.workspaceRoot} 共 ${summary.scanned} 个文件，` +
                  `其中 ${summary.pending.length} 个需要上传（${formatBytes(summary.totalBytes)} 总计），` +
                  `${summary.unchanged} 个未变化。目标目录 ${summary.remoteDir}`,
                workspaceRoot: summary.workspaceRoot,
                remoteDir: summary.remoteDir,
                scanned: summary.scanned,
                totalBytesText: formatBytes(summary.totalBytes),
                uploaded: 0,
                unchanged: summary.unchanged,
                failed: 0,
                truncated: Boolean(summary.truncated),
                pending: summary.pending.slice(0, 200).map((f) => ({ rel: f.rel, size: f.size })),
              };
            }
            const failCount = summary.failed?.length ?? 0;
            return {
              ok: failCount === 0,
              message:
                `备份完成：${summary.remoteDir} ← ${summary.workspaceRoot}\n` +
                `扫描 ${summary.scanned} 个文件（${formatBytes(summary.totalBytes)}），` +
                `新上传 ${summary.uploaded} 个，未变化 ${summary.unchanged} 个` +
                (failCount ? `，失败 ${failCount} 个` : '') +
                (summary.truncated ? '（文件数超过上限，已截断）' : ''),
              workspaceRoot: summary.workspaceRoot,
              remoteDir: summary.remoteDir,
              scanned: summary.scanned,
              totalBytesText: formatBytes(summary.totalBytes),
              uploaded: summary.uploaded,
              unchanged: summary.unchanged,
              failed: failCount,
              truncated: Boolean(summary.truncated),
              pending: [],
            };
          } catch (error) {
            return {
              ok: false,
              message: fail(error).message,
              workspaceRoot: root,
              remoteDir: String(args.remoteDir ?? ''),
              scanned: 0,
              totalBytesText: '0 B',
              uploaded: 0,
              unchanged: 0,
              failed: 0,
              truncated: false,
              pending: [],
            };
          }
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_backup_status',
        description:
          'Show recorded 123 Cloud Drive (123云盘) backup runs for this machine: workspace root, remote folder, file count, last run time and failures.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    workspaceRoot: { type: 'string' },
                    remoteDir: { type: 'string' },
                    files: { type: 'number' },
                    lastRun: { type: 'string' },
                    lastUploaded: { type: 'number' },
                    lastFailed: { type: 'number' },
                  },
                },
              },
            },
          },
          render(args, value) {
            return [{ type: 'text', text: value.message }];
          },
        },
        async execute() {
          const records = listBackupRecords(config()).map((r) => ({
            workspaceRoot: r.workspaceRoot,
            remoteDir: r.remoteDir,
            files: Object.keys(r.files ?? {}).length,
            lastRun: String(r.lastRun ?? ''),
            lastUploaded: Number(r.lastUploaded) || 0,
            lastFailed: Number(r.lastFailed) || 0,
          }));
          if (records.length === 0) {
            return { ok: true, message: '还没有备份记录。调用 pan123_backup_workspace 开始第一次备份。', records: [] };
          }
          const lines = [`共 ${records.length} 条备份记录：`];
          for (const r of records) {
            lines.push(
              `- ${r.remoteDir} ← ${r.workspaceRoot}：${r.files} 个文件，上次 ${r.lastRun || '未知'}` +
                `（上传 ${r.lastUploaded}，失败 ${r.lastFailed}）`
            );
          }
          return { ok: true, message: lines.join('\n'), records };
        },
      })
    )
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pan123_scan_workspace',
        description:
          'Preview which workspace files would be uploaded by pan123_backup_workspace, without contacting 123 Cloud Drive. Useful to check ignore rules and size limits.',
        parameters: {
          workspaceRoot: { type: 'string', description: 'Workspace directory; defaults to the current working directory.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              files: { type: 'number' },
              bytesText: { type: 'string' },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { rel: { type: 'string' }, reason: { type: 'string' } },
                },
              },
            },
          },
          render(args, value) {
            const lines = [value.message];
            const list = value.skipped ?? [];
            for (const s of list.slice(0, 5)) lines.push(`- 跳过 ${s.rel}（${s.reason}）`);
            if (list.length > 5) lines.push(`… 另有 ${list.length - 5} 项被跳过`);
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args, exec) {
          const cwd = exec?.cwd || process.cwd();
          const root = String(args.workspaceRoot ?? '').trim() || cwd;
          try {
            const scan = scanWorkspace(root, {
              ignoreDirs: config()?.ignoreDirs,
              ignoreGlobs: config()?.ignoreGlobs,
              maxFileBytes: config()?.maxFileBytes,
              maxFiles: config()?.maxFiles,
            });
            const bytes = scan.files.reduce((s, f) => s + f.size, 0);
            return {
              ok: true,
              message:
                `${root}：将备份 ${scan.files.length} 个文件（${formatBytes(bytes)}），` +
                `跳过 ${scan.skipped.length} 项` +
                (scan.truncated ? '（达到文件数上限，已截断）' : ''),
              files: scan.files.length,
              bytesText: formatBytes(bytes),
              skipped: scan.skipped.slice(0, 100).map((s) => ({ rel: s.rel, reason: s.reason })),
            };
          } catch (error) {
            return { ok: false, message: fail(error).message, files: 0, bytesText: '0 B', skipped: [] };
          }
        },
      })
    )
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}
