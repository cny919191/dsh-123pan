// 端到端：uploadStart 的进度必须真的在动（bytes/total 递增），完成后大小一致
import http from 'node:http';
import fs from 'node:fs';
import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';

const SIZE_MB = Number(process.argv[2] || 60);
const tmp = `D:/python/plugins/dsh-123pan/_prog_${SIZE_MB}mb.bin`;

// 生成一个随机内容的临时文件（避免秒传，才能看到进度）
const chunk = Buffer.alloc(1024 * 1024);
for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + Date.now()) & 0xff;
const fd = fs.openSync(tmp, 'w');
for (let i = 0; i < SIZE_MB; i++) {
  chunk[0] = i & 0xff;
  fs.writeSync(fd, chunk);
}
fs.closeSync(fd);
const localSize = fs.statSync(tmp).size;
console.log(`临时文件：${SIZE_MB} MB（${localSize} 字节）`);

const routes = createRoutes({ config: () => ({}), logger: console, getWorkspaceRoot: () => 'D:/python' });
const byPath = new Map(routes.map((r) => [r.path, r]));
const server = http.createServer(async (req, res) => {
  const p = String(req.url || '').split('?')[0];
  const route = byPath.get(p);
  if (!route) { res.writeHead(404); res.end(); return; }
  await route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const post = (name, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}/api/dsh-123pan/${name}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf.slice(0, 200))); } });
      }
    );
    req.on('error', reject);
    req.end(data);
  });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

let fileId = 0;
try {
  // 故意用带引号的路径，同时验证清洗
  const started = await post('uploadStart', { file: '"' + tmp + '"', parentId: 0 });
  check('uploadStart 返回 taskId', started.ok && Boolean(started.value?.taskId), JSON.stringify(started).slice(0, 120));
  const taskId = started.value.taskId;
  check('返回的总大小与本地一致', started.value.total === localSize, `${started.value.total} vs ${localSize}`);

  const samples = [];
  let state = null;
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 500));
    state = (await post('uploadState', { taskId })).value;
    samples.push({ b: state.bytes, t: state.total, f: state.fraction, s: state.stage, st: state.state });
    if (state.state !== 'running') break;
  }

  // 均匀取 10 条，避免只看开头（分片进度出现在后段）
  console.log(`进度采样（共 ${samples.length} 次，均匀取 10 条）：`);
  const step = Math.max(1, Math.floor(samples.length / 10));
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    console.log(`   ${String(s.b).padStart(10)} / ${s.t}  ${(s.f * 100).toFixed(1)}%  [${s.st}] ${s.s}`);
  }

  const increasing = samples.some((s) => s.b > 0) && samples.some((s) => s.b > samples[0].b);
  check('进度 bytes 有增长（不是一直 0）', increasing, `首=${samples[0]?.b} 最大=${Math.max(...samples.map((s) => s.b))}`);
  check('最终 state = done', state.state === 'done', `${state.state} ${state.error || ''}`);
  check('最终 bytes == total', state.bytes === state.total, `${state.bytes}/${state.total}`);

  const result = state.result || {};
  fileId = result.fileId || 0;
  check('云端大小与本地一致', result.size === localSize, `${result.size} vs ${localSize}`);
} finally {
  if (fileId) {
    try { await core.coreTrash({}, { fileIds: [fileId] }); await core.corePurge({}, { fileIds: [fileId] }); } catch { /* ignore */ }
  }
  fs.rmSync(tmp, { force: true });
  server.close();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
