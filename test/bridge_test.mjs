import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';
import fs from 'node:fs';

const cfg = {};
await core.coreLogin(cfg, { account: '19900000001', password: '123456' });

const routes = createRoutes({ config: () => cfg, logger: console, getWorkspaceRoot: () => process.cwd() });
console.log('routes:', routes.length, routes.slice(0,3).map(r=>r.path).join(', '));

// 直接调用 handler，模拟 req/res
const fakeRes = () => {
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(s) { out.status = s; },
    end(payload) { out.body = JSON.parse(payload); },
  };
};
const fakeReq = (method='POST') => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: '127.0.0.1:64363', origin: 'http://127.0.0.1:64363' },
  method,
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({})); },
});

const byName = Object.fromEntries(routes.map(r => [r.path.split('/').pop(), r]));
for (const name of ['status', 'list', 'backups']) {
  const res = fakeRes();
  await byName[name].handler(fakeReq(), res);
  console.log(name, '->', res.out.status, JSON.stringify(res.out.body).slice(0, 160));
}

// 安全门禁测试
const badRes = fakeRes();
const badReq = { socket:{remoteAddress:'10.0.0.5'}, headers:{host:'evil.com'}, method:'POST', async *[Symbol.asyncIterator](){} };
await byName.status.handler(badReq, badRes);
console.log('非本机请求 ->', badRes.out.status, JSON.stringify(badRes.out.body));

const getRes = fakeRes();
await byName.status.handler(fakeReq('GET'), getRes);
console.log('GET ->', getRes.out.status, JSON.stringify(getRes.out.body));
