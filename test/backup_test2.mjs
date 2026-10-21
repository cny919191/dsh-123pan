import * as m from '../lib/core.js';
import { runBackup } from '../lib/backup.js';
import fs from 'node:fs';
import path from 'node:path';

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
await m.coreLogin(cfg, { account: requireEnv('PAN123_TEST_ACCOUNT'), password: requireEnv('PAN123_TEST_PASSWORD'), save: true });

const root = path.resolve('_test/ws');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(root, '.git'), { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), 'hello 123pan');
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'same name different dir');
fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.txt'), 'deep file');
fs.writeFileSync(path.join(root, 'node_modules', 'skip.js'), 'ignored');
fs.writeFileSync(path.join(root, '.git', 'x'), 'ignored');

const s1 = await runBackup({ workspaceRoot: root, config: cfg, remoteDir: '_dsh_test_backup2',
  onEvent: e => { if (e.type==='file-done') console.log('  up:', e.rel, e.reused?'(reused)':''); if (e.type==='file-fail') console.log('  FAIL', e.rel, e.error); } });
console.log('1st:', JSON.stringify({uploaded:s1.uploaded, failed:s1.failed.length, dirId:s1.remoteDirId}));

// 打印远端树
const show = async (pid, indent='  ') => {
  const l = await m.coreList(cfg, { parentId: pid, limit: 100 });
  for (const it of l.items || []) {
    console.log(indent + (it.type===1?'[D] ':'    ') + it.name + (it.type===0?` (${it.size}B)`:'')); 
    if (it.type===1) await show(it.fileId, indent + '  ');
  }
};
console.log('远端目录树:'); await show(s1.remoteDirId);

const s2 = await runBackup({ workspaceRoot: root, config: cfg, remoteDir: '_dsh_test_backup2' });
console.log('2nd:', JSON.stringify({uploaded:s2.uploaded, unchanged:s2.unchanged}));

// 修改一个文件 -> 只应传 1 个
fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'changed content here');
const s3 = await runBackup({ workspaceRoot: root, config: cfg, remoteDir: '_dsh_test_backup2',
  onEvent: e => { if (e.type==='file-done') console.log('  3rd up:', e.rel); } });
console.log('3rd:', JSON.stringify({uploaded:s3.uploaded, unchanged:s3.unchanged}));
