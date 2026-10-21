import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';
import fs from 'node:fs';

// 测试账号只能从环境变量取，避免把别人的账号写进仓库、也避免覆盖已保存的登录态
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}。测试会登录并改写已保存的会话，必须显式提供：`);
    console.error('  set PAN123_TEST_ACCOUNT=你的测试账号');
    console.error('  set PAN123_TEST_PASSWORD=你的测试密码');
    process.exit(2);
  }
  return v;
}

const cfg = {};
await core.coreLogin(cfg, { account: requireEnv('PAN123_TEST_ACCOUNT'), password: requireEnv('PAN123_TEST_PASSWORD') });

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
