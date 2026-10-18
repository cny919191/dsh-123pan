import * as c from '../lib/core.js';
const cfg = {};
console.log('dataDir:', c.dataDir(cfg));

// 清理旧会话
c.clearSession(cfg);

console.log('\n-- status (未登录) --');
console.log(await c.coreStatus(cfg));

console.log('\n-- login --');
const r = await c.coreLogin(cfg, { account: '19900000001', password: '123456' });
console.log({ nickname: r.nickname, uid: r.uid, saved: r.saved });

console.log('\n-- status --');
const st = await c.coreStatus(cfg);
console.log({ loggedIn: st.loggedIn, nickname: st.nickname, spaceUsed: st.spaceUsed, spaceTotal: st.spaceTotal });

console.log('\n-- list --');
const l = await c.coreList(cfg, { limit: 3 });
console.log({ total: l.total, first: (l.items || []).slice(0, 3).map(i => i.name) });
