import { createRoutes } from '../lib/bridge.js';
const rs = createRoutes({
  config: () => ({ storeDir: 'D:/python/plugins/dsh-123pan/.tmpx' }),
  logger: console,
  getWorkspaceRoot: () => 'D:/python',
  getSessionCwds: () => [{ id: 's1', cwd: 'D:/python', createdAt: 1 }],
});
const by = Object.fromEntries(rs.map((r) => [r.path.split('/').pop(), r]));
const res = () => {
  const o = { s: 0, b: null };
  return { o, writeHead(x) { o.s = x; }, end(p) { o.b = JSON.parse(p); } };
};
const req = () => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
  method: 'POST',
  url: '/x',
  async *[Symbol.asyncIterator]() {},
});
const r = res();
await by.diag.handler(req(), r);
console.log('路由数:', rs.length);
console.log(JSON.stringify(r.o.b.value, null, 1));
