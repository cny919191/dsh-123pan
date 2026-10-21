import * as c from '../lib/core.js';

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
console.log('dataDir:', c.dataDir(cfg));

// 清理旧会话
c.clearSession(cfg);

console.log('\n-- status (未登录) --');
console.log(await c.coreStatus(cfg));

console.log('\n-- login --');
const r = await c.coreLogin(cfg, { account: requireEnv('PAN123_TEST_ACCOUNT'), password: requireEnv('PAN123_TEST_PASSWORD') });
console.log({ nickname: r.nickname, uid: r.uid, saved: r.saved });

console.log('\n-- status --');
const st = await c.coreStatus(cfg);
console.log({ loggedIn: st.loggedIn, nickname: st.nickname, spaceUsed: st.spaceUsed, spaceTotal: st.spaceTotal });

console.log('\n-- list --');
const l = await c.coreList(cfg, { limit: 3 });
console.log({ total: l.total, first: (l.items || []).slice(0, 3).map(i => i.name) });
