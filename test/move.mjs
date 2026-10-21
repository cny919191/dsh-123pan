// 移动功能的回归测试：防止再退回「静默成功」
//
// 1. 在根目录建一个探针文件并上传
// 2. 建（或复用）一个测试目录
// 3. 调用 move 把文件移进去
// 4. 在目标目录的列表里必须能找到它，根目录必须没有
// 5. 清理：删掉探针文件
import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ACCOUNT = process.env.PAN123_TEST_ACCOUNT || '19900000001';
const PASSWORD = process.env.PAN123_TEST_PASSWORD || '123456';

const cfg = {};
await core.coreLogin(cfg, { account: ACCOUNT, password: PASSWORD });

const routes = createRoutes({
  config: () => cfg,
  logger: { info() {}, warn() {}, error() {} },
  getWorkspaceRoot: () => process.cwd(),
});
const byName = Object.fromEntries(routes.map((r) => [r.path.split('/').pop(), r]));

const fakeRes = () => {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(s) { out.status = s; },
    end(payload) { out.body = JSON.parse(payload); },
  };
};
const fakeReq = (body = {}) => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:64363', origin: 'http://127.0.0.1:64363' },
  method: 'POST',
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify(body));
  },
});
const call = async (name, body = {}) => {
  const res = fakeRes();
  await byName[name].handler(fakeReq(body), res);
  return res.out.body;
};

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  ok ? pass++ : fail++;
};

// ---- 准备：探针文件 ----
const stamp = Date.now();
const probeName = `_move_test_${stamp}.txt`;
const probePath = path.join(os.tmpdir(), probeName);
fs.writeFileSync(probePath, `move test ${new Date().toISOString()}\n`);

const up = await call('upload', { file: probePath, parentId: 0, name: probeName });
check(up?.ok === true, `上传探针文件 ${probeName}`);
const fileId = up?.value?.fileId ?? up?.value?.info?.fileId;
check(!!fileId, `拿到 fileId: ${fileId}`);

// ---- 准备：目标目录 ----
const dirName = `_move_test_dir_${stamp}`;
const mk = await call('mkdir', { parentId: 0, name: dirName });
const dirId = mk?.value?.fileId ?? mk?.value?.info?.fileId ?? mk?.value?.parentId;
check(!!dirId && mk?.ok === true, `建目标目录 ${dirName} (id ${dirId})`);

// ---- 执行移动 ----
const mv = await call('move', { fileIds: [Number(fileId)], parentId: Number(dirId) });
check(mv?.ok === true, `调用 move（返回 ${JSON.stringify(mv?.value ?? mv).slice(0, 80)}）`);

// ---- 校验：目标目录里必须有 ----
const inDir = await call('list', { parentId: Number(dirId) });
const items = inDir?.value?.items ?? inDir?.value?.list ?? [];
const found = items.some((it) => Number(it.fileId) === Number(fileId));
check(found, `目标目录里能找到该文件（共 ${items.length} 项）`);

// ---- 校验：根目录里必须没有 ----
const atRoot = await call('list', { parentId: 0 });
const rootItems = atRoot?.value?.items ?? atRoot?.value?.list ?? [];
const stillAtRoot = rootItems.some((it) => Number(it.fileId) === Number(fileId));
check(!stillAtRoot, '根目录里已经没有该文件（说明真的移动了，不是静默成功）');

// ---- 清理 ----
if (found) {
  await call('trash', { fileIds: [Number(fileId)] });
  console.log('  · 探针文件已送回收站');
}
if (dirId) {
  await call('trash', { fileIds: [Number(dirId)] });
  console.log('  · 测试目录已送回收站');
}
try { fs.unlinkSync(probePath); } catch {}

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
