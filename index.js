// index.js — dsh-123pan 的 Host 侧入口
//
// 提供三件事：
//   1. 给 agent 用的 123pan_* 工具（登录、列目录、上传、下载、工作区备份…）
//   2. 给 Web UI 用的本机 HTTP 桥（/api/dsh-123pan/*），UI 通过它驱动同一个核心
//   3. 插件生命周期：注册工具、注册路由，退出时全部释放
//
// 真正的网络与文件操作都在 native/core/123pan-core.exe 里完成，
// 这里不做 HTTP 客户端，也不碰加密逻辑。

import fs from 'node:fs';
import path from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { createRoutes } from './lib/bridge.js';
import { dataDir, resolveCore, sessionPath } from './lib/core.js';
import { registerTools } from './lib/tools.js';

export const inject = ['tools'];

const DEFAULTS = {
  defaultRemoteDir: '',
  ignoreDirs: undefined,
  ignoreGlobs: undefined,
  maxFileBytes: 200 * 1024 * 1024,
  maxFiles: 5000,
  storeDir: '',
  corePath: '',
  downloadDir: '',
  workspaceRoot: '',
  // 直接用 API Key（JWT）当会话，无需登录。留空则使用加密保存的会话。
  apiToken: '',
};

function normalizeConfig(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
    }
  }
  return out;
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} config profile patch 提供的配置
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  const current = () => resolved;
  const logger = ctx.logger ?? console;

  // 启动自检：把数据目录建好，核心缺失要让用户看得见（而不是等到第一次调用才报错）。
  ctx.effect(() => {
    const dir = dataDir(resolved);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      logger.warn?.(`[dsh-123pan] 无法创建数据目录 ${dir}: ${error?.message ?? error}`);
    }
    const core = resolveCore(resolved);
    if (!fs.existsSync(core)) {
      logger.warn?.(`[dsh-123pan] 未找到核心程序 ${core}，123pan 工具将不可用（可用 corePath 配置指定）`);
    } else {
      logger.info?.(`[dsh-123pan] 核心 ${core}`);
    }
    logger.info?.(`[dsh-123pan] 数据目录 ${dir}，会话文件 ${sessionPath(resolved)}`);
    return () => {};
  }, 'dsh-123pan: init');

  // ---- 工具 ----
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(
      () => registerTools(sctx, { config: current, defineTool, logger }),
      'dsh-123pan: tools'
    );
  });

  // ---- Web 桥 ----
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      /**
       * 当前工作区目录。优先级：
       *   1. 插件配置 workspaceRoot（强制指定）
       *   2. 最近创建的活跃会话的 header.cwd —— 这才是用户真正打开的项目目录，
       *      workingDirectory.defaultDirectory 只是部署级兜底（曾导致误取 profile 目录）
       *   3. workingDirectory.defaultDirectory
       *   4. 进程 cwd
       */
      const resolveWorkspaceRoot = () => {
        const forced = String(current()?.workspaceRoot ?? '').trim();
        if (forced) return forced;
        try {
          const store = ctx.get?.('sessions');
          const list = store?.list?.() ?? [];
          // 取「最近有活动」的会话：用最后一条事件的 time 排序，
          // 空会话退回创建时间。用户切换工作区后，新工作区的会话会先有活动。
          let best = null;
          let bestTime = -1;
          for (const session of list) {
            const cwd = session?.header?.cwd;
            if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
            let t = Number(session?.header?.createdAt ?? 0);
            try {
              const seq = Number(session?.seq ?? 0);
              if (seq > 0) {
                const last = session.eventAt?.(seq - 1);
                if (last?.time) t = Math.max(t, Number(last.time));
              }
            } catch {
              /* ignore */
            }
            if (t >= bestTime && fs.existsSync(cwd)) {
              bestTime = t;
              best = cwd;
            }
          }
          if (best) return best;
        } catch {
          /* ignore */
        }
        try {
          const wd = ctx.get?.('workingDirectory');
          if (wd?.defaultDirectory) return wd.defaultDirectory;
        } catch {
          /* ignore */
        }
        return process.cwd();
      };

      const routes = createRoutes({
        config: current,
        logger,
        getWorkspaceRoot: resolveWorkspaceRoot,
        // 诊断用：列出所有活跃会话的 cwd，方便排查「工作区没跟着变」
        getSessionCwds: () => {
          try {
            const list = ctx.get?.('sessions')?.list?.() ?? [];
            return list.map((session) => ({
              id: String(session?.id ?? ''),
              cwd: session?.header?.cwd ?? null,
              createdAt: session?.header?.createdAt ?? null,
            }));
          } catch {
            return [];
          }
        },
      });
      const disposers = routes.map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      };
    }, 'dsh-123pan: web bridge');
  });
}
