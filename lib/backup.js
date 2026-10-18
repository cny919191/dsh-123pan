// lib/backup.js — 工作区备份（扫描 → 增量上传 → 记录清单）
//
// 目标：把工作区文件上传到 123 云盘的某个目录，并跳过没变化的文件，
// 让「备份」可以反复执行而不重复传。
//
// 增量判据：相对路径 + 文件大小 + 修改时间(mtimeMs)。
// 清单存在 <数据目录>/backups.json，按「工作区 + 远端目录」分区。

import fs from 'node:fs';
import path from 'node:path';

import { coreMkdir, coreUpload, coreList, dataDir, manifestPath } from './core.js';

/** 默认不备份的目录/文件（与 .gitignore 无关，纯粹为省流量与时间）。 */
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'target',
  '.dsh-123pan-staging',
  '.dsh-123pan',
];

export const DEFAULT_IGNORE_GLOBS = [
  '*.tmp',
  '*.temp',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '*.pyc',
];

function matchGlob(name, pattern) {
  // 只支持 * 与 ?，足够处理常见忽略规则
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(name);
  } catch {
    return false;
  }
}

/**
 * 扫描工作区，返回待备份文件列表。
 *
 * @param {string} root 工作区根目录
 * @param {object} options
 * @param {string[]} [options.ignoreDirs]
 * @param {string[]} [options.ignoreGlobs]
 * @param {number} [options.maxFileBytes] 单文件上限（默认 200MB）
 * @param {number} [options.maxFiles]     文件数上限（默认 5000）
 * @returns {{files: Array<{abs:string,rel:string,size:number,mtimeMs:number}>, skipped: Array<{rel:string,reason:string}>, truncated: boolean}}
 */
export function scanWorkspace(root, options = {}) {
  const ignoreDirs = new Set((options.ignoreDirs ?? DEFAULT_IGNORE_DIRS).map((s) => String(s).toLowerCase()));
  const ignoreGlobs = options.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS;
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : 200 * 1024 * 1024;
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 5000;

  const files = [];
  const skipped = [];
  let truncated = false;

  const walk = (dir) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({ rel: path.relative(root, dir) || '.', reason: `无法读取目录：${error.code || error.message}` });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        skipped.push({ rel, reason: '符号链接' });
        continue;
      }
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name.toLowerCase())) {
          skipped.push({ rel, reason: '忽略目录' });
          continue;
        }
        walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ rel, reason: '非普通文件' });
        continue;
      }
      if (ignoreGlobs.some((g) => matchGlob(entry.name, g))) {
        skipped.push({ rel, reason: '忽略规则' });
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (error) {
        skipped.push({ rel, reason: `无法读取属性：${error.code || error.message}` });
        continue;
      }
      if (stat.size > maxFileBytes) {
        skipped.push({ rel, reason: `超过单文件上限 ${Math.round(maxFileBytes / 1024 / 1024)}MB` });
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ abs, rel, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    }
  };

  walk(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped, truncated };
}

// ---------------- 清单 ----------------

function readManifest(config) {
  const file = manifestPath(config);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') return data;
  } catch {
    /* 不存在或损坏：当空清单处理 */
  }
  return { version: 1, entries: {} };
}

function writeManifest(config, manifest) {
  const file = manifestPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function manifestKey(workspaceRoot, remoteDir) {
  return `${path.resolve(workspaceRoot)}::${remoteDir}`;
}

/** 读取某个工作区+远端目录的备份记录。 */
export function readBackupRecord(config, workspaceRoot, remoteDir) {
  const manifest = readManifest(config);
  return manifest.entries[manifestKey(workspaceRoot, remoteDir)] ?? null;
}

/** 列出全部备份记录（用于界面展示）。 */
export function listBackupRecords(config) {
  const manifest = readManifest(config);
  return Object.entries(manifest.entries).map(([key, value]) => {
    const [root, remoteDir] = key.split('::');
    return { key, workspaceRoot: root, remoteDir, ...value };
  });
}

/**
 * 确保远端目录存在（已存在同名目录则复用）。
 * 返回目录 FileId。
 */
async function ensureRemoteDir(config, remoteDir, onProgress) {
  const parts = String(remoteDir)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  let parentId = 0;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    onProgress?.(0, `准备远端目录 ${parts.slice(0, i + 1).join('/')}`);
    const listing = await coreList(config, { parentId, limit: 200 });
    const existing = (listing.items || []).find((it) => it.type === 1 && it.name === name);
    if (existing) {
      parentId = existing.fileId;
      continue;
    }
    const created = await coreMkdir(config, { name, parentId });
    parentId = created.fileId;
  }
  return parentId;
}

/** 目录列表缓存：一次 list 拿全部子项，避免每个文件都启动一次子进程。 */
function makeDirResolver(config, rootDirId) {
  const cache = new Map(); // key: `${parentId}|${name}` -> fileId
  const listings = new Map(); // parentId -> Map(name -> item)

  const listOnce = async (parentId) => {
    if (listings.has(parentId)) return listings.get(parentId);
    const byName = new Map();
    try {
      // 目录可能超过 200 项，翻页取全
      let next = '';
      for (let page = 0; page < 20; page++) {
        const data = await coreList(config, { parentId, limit: 200, next: next || undefined });
        for (const it of data.items || []) {
          if (it.type === 1) byName.set(it.name, it);
        }
        next = String(data.next ?? '');
        if (!next || next === '-1') break;
      }
    } catch {
      /* 列表失败就当作空目录，后续会尝试创建 */
    }
    listings.set(parentId, byName);
    return byName;
  };

  return async (relDir) => {
    const parts = String(relDir).split('/').filter(Boolean);
    let parent = rootDirId;
    for (const part of parts) {
      const key = `${parent}|${part}`;
      const cached = cache.get(key);
      if (cached) {
        parent = cached;
        continue;
      }
      const byName = await listOnce(parent);
      const hit = byName.get(part);
      if (hit) {
        cache.set(key, hit.fileId);
        parent = hit.fileId;
        continue;
      }
      const created = await coreMkdir(config, { name: part, parentId: parent });
      cache.set(key, created.fileId);
      byName.set(part, { fileId: created.fileId, name: part, type: 1 });
      parent = created.fileId;
    }
    return parent;
  };
}

/**
 * 执行一次备份。
 *
 * @param {object} params
 * @param {string} params.workspaceRoot 工作区根目录
 * @param {object} params.config         插件配置
 * @param {string} [params.remoteDir]    远端目录（默认 dsh-backup/<工作区名>）
 * @param {boolean} [params.dryRun]      只扫描不传输
 * @param {(evt:object)=>void} [params.onEvent] 进度事件
 * @returns {Promise<object>} 汇总
 */
export async function runBackup(params) {
  const { workspaceRoot, config, dryRun = false, onEvent } = params;
  const root = path.resolve(workspaceRoot);
  const remoteDir = (params.remoteDir || config?.defaultRemoteDir || `dsh-backup/${path.basename(root) || 'workspace'}`)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

  const emit = (evt) => {
    try {
      onEvent?.(evt);
    } catch {
      /* 事件回调异常不影响备份 */
    }
  };

  emit({ type: 'phase', phase: 'scan', message: `扫描工作区 ${root}` });
  const scan = scanWorkspace(root, {
    ignoreDirs: config?.ignoreDirs,
    ignoreGlobs: config?.ignoreGlobs,
    maxFileBytes: config?.maxFileBytes,
    maxFiles: config?.maxFiles,
  });
  const totalBytes = scan.files.reduce((sum, f) => sum + f.size, 0);
  emit({
    type: 'scan',
    files: scan.files.length,
    bytes: totalBytes,
    skipped: scan.skipped.length,
    truncated: scan.truncated,
  });

  const record = readBackupRecord(config, root, remoteDir);
  const known = record?.files ?? {};
  const pending = [];
  let unchanged = 0;
  for (const file of scan.files) {
    const prev = known[file.rel];
    if (prev && prev.size === file.size && prev.mtimeMs === file.mtimeMs) {
      unchanged++;
      continue;
    }
    pending.push(file);
  }
  emit({ type: 'plan', pending: pending.length, unchanged });

  if (dryRun) {
    return {
      dryRun: true,
      workspaceRoot: root,
      remoteDir,
      scanned: scan.files.length,
      totalBytes,
      pending: pending.map((f) => ({ rel: f.rel, size: f.size })),
      unchanged,
      skipped: scan.skipped,
      truncated: scan.truncated,
    };
  }

  if (pending.length === 0) {
    const summary = {
      workspaceRoot: root,
      remoteDir,
      scanned: scan.files.length,
      totalBytes,
      uploaded: 0,
      unchanged,
      failed: [],
      skipped: scan.skipped,
      truncated: scan.truncated,
      finishedAt: new Date().toISOString(),
    };
    writeManifest(config, mergeRecord(config, root, remoteDir, known, summary));
    emit({ type: 'done', ...summary });
    return summary;
  }

  const dirId = await ensureRemoteDir(config, remoteDir, (frac, stage) => emit({ type: 'phase', phase: 'remote', message: stage }));
  emit({ type: 'phase', phase: 'upload', message: `开始上传 ${pending.length} 个文件` });

  const uploaded = [];
  const failed = [];
  const nextKnown = { ...known };
  // 远端子目录缓存：把 'sub/deep' 映射到 FileId，避免每个文件都全量 list
  // 目录解析器：带缓存，避免每个文件都列一次目录（那会让子进程启动次数变成平方级）
  const resolveDir = makeDirResolver(config, dirId);
  const dirFor = (rel) => resolveDir(rel.split('/').slice(0, -1).join('/'));

  let index = 0;
  for (const file of pending) {
    index++;
    const label = `[${index}/${pending.length}] ${file.rel}`;
    emit({ type: 'file-start', rel: file.rel, size: file.size, index, total: pending.length });
    try {
      // 保持目录结构：远端把 'sub/deep/x.txt' 还原成同名层级，
      // 否则不同子目录下的同名文件会互相覆盖。
      const targetDir = await dirFor(file.rel);
      const result = await coreUpload(config, {
        file: file.abs,
        parentId: targetDir,
        name: path.basename(file.rel),
        onProgress: (fraction, stage) =>
          emit({ type: 'file-progress', rel: file.rel, fraction, stage, index, total: pending.length }),
      });
      nextKnown[file.rel] = {
        size: file.size,
        mtimeMs: file.mtimeMs,
        fileId: result.fileId,
        etag: result.etag,
        uploadedAt: new Date().toISOString(),
      };
      uploaded.push({ rel: file.rel, fileId: result.fileId, reused: !!result.reused });
      emit({ type: 'file-done', rel: file.rel, fileId: result.fileId, reused: !!result.reused, label });
    } catch (error) {
      failed.push({ rel: file.rel, error: error?.message ?? String(error) });
      emit({ type: 'file-fail', rel: file.rel, error: error?.message ?? String(error) });
    }
  }

  const summary = {
    workspaceRoot: root,
    remoteDir,
    remoteDirId: dirId,
    scanned: scan.files.length,
    totalBytes,
    uploaded: uploaded.length,
    unchanged,
    failed,
    skipped: scan.skipped,
    truncated: scan.truncated,
    finishedAt: new Date().toISOString(),
  };
  writeManifest(config, mergeRecord(config, root, remoteDir, nextKnown, summary));
  emit({ type: 'done', ...summary });
  return summary;
}

function mergeRecord(config, root, remoteDir, files, summary) {
  const manifest = readManifest(config);
  const key = manifestKey(root, remoteDir);
  manifest.version = 1;
  manifest.entries[key] = {
    remoteDir,
    remoteDirId: summary.remoteDirId,
    files,
    lastRun: summary.finishedAt,
    lastUploaded: summary.uploaded,
    lastFailed: summary.failed?.length ?? 0,
    scanned: summary.scanned,
    totalBytes: summary.totalBytes,
  };
  return manifest;
}

/** 清空某个工作区的备份记录（不影响云端文件）。 */
export function forgetBackup(config, workspaceRoot, remoteDir) {
  const manifest = readManifest(config);
  const key = manifestKey(workspaceRoot, remoteDir);
  const existed = Boolean(manifest.entries[key]);
  delete manifest.entries[key];
  writeManifest(config, manifest);
  return existed;
}
