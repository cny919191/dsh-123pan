// 诊断：媒体代理的 Range 行为（模拟浏览器 seek）
// 只取响应头 + 首个数据块就断开，不拉完整文件
import http from 'node:http';
import { createRoutes } from '../lib/bridge.js';

const VIDEO_ID = Number(process.argv[2] || 46817330);
const NAME = process.argv[3] || '93阅兵.mp4';

const routes = createRoutes({ config: () => ({}), logger: console, getWorkspaceRoot: () => 'D:/python' });
const byPath = new Map(routes.map((r) => [r.path, r]));
const server = http.createServer(async (req, res) => {
  const p = String(req.url || '').split('?')[0];
  const route = byPath.get(p);
  if (!route) { res.writeHead(404); res.end(); return; }
  await route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/api/dsh-123pan/media?id=${VIDEO_ID}&name=${encodeURIComponent(NAME)}`;

function probe(label, headers) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve({ label, ms: Date.now() - t0, ...v });
    };
    const req = http.get(url, { headers }, (res) => {
      // 拿到响应头就够了
      done({
        status: res.statusCode,
        type: res.headers['content-type'],
        len: res.headers['content-length'],
        range: res.headers['content-range'],
        accept: res.headers['accept-ranges'],
        encoding: res.headers['content-encoding'],
      });
      res.destroy();
      req.destroy();
    });
    req.on('error', (e) => done({ error: e.message }));
    setTimeout(() => { done({ error: 'timeout' }); req.destroy(); }, 15000);
  });
}

const cases = [
  ['无 Range', {}],
  ['bytes=0-', { range: 'bytes=0-' }],
  ['跳 60%', { range: 'bytes=443762155-' }],
  ['尾部 4KB', { range: 'bytes=739599000-' }],
  ['中段 1MB', { range: 'bytes=100000000-1001048575' }],
];

for (const [label, h] of cases) {
  const r = await probe(label, h);
  if (r.error) {
    console.log(`${label.padEnd(12)} ✗ ${r.error} (${r.ms}ms)`);
    continue;
  }
  console.log(
    `${label.padEnd(12)} ${r.status} len=${r.len} range=${r.range || '-'} accept=${r.accept} enc=${r.encoding || '-'} (${r.ms}ms)`
  );
}
server.close();
process.exit(0);
