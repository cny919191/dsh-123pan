import * as c from '../lib/core.js';
import fs from 'node:fs';
import path from 'node:path';

const cfg = {};
console.log('login...');
await c.coreLogin(cfg, { account: '19900000001', password: '123456' });

// 建一个含中文、空格、特殊符号的测试目录
const name = '测试 目录#1 (v2)';
const made = await c.coreMkdir(cfg, { name, parentId: 0 });
console.log('mkdir:', JSON.stringify(made));

// 把本地文件传上去，文件名也带中文
const tmp = path.resolve('_test');
fs.mkdirSync(tmp, { recursive: true });
const local = path.join(tmp, '测试文件 含空格#.txt');
fs.writeFileSync(local, '中文内容 test 123');

const up = await c.coreUpload(cfg, { file: local, parentId: made.fileId });
console.log('upload:', JSON.stringify(up));

// 列表确认
const l = await c.coreList(cfg, { parentId: made.fileId, limit: 10 });
console.log('list:', (l.items||[]).map(i => i.name));

// 搜索中文
const s = await c.coreList(cfg, { search: '测试文件', limit: 5 });
console.log('search:', (s.items||[]).map(i => i.name));

// 下载回来比对
const back = path.join(tmp, 'back.txt');
const dl = await c.coreDownload(cfg, { fileId: up.fileId, out: back });
const a = fs.readFileSync(local); const b = fs.readFileSync(back);
console.log('download bytes:', dl.bytes, 'same:', a.equals(b));

// 清理
await c.coreTrash(cfg, { fileIds: [made.fileId] });
const tr = await c.coreList(cfg, { trashed: true, limit: 500 });
const junk = (tr.items||[]).filter(i => i.name === name || i.name === '测试文件 含空格#.txt');
if (junk.length) { const p = await c.corePurge(cfg, { fileIds: junk.map(i=>i.fileId) }); console.log('purged:', p.count); }
fs.unlinkSync(local); fs.unlinkSync(back);
