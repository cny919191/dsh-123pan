// test/token_login.mjs — 用 API Key（token）直接登录，并跑通上传/下载/删除。
// 用法：node test/token_login.mjs [tokenFile]
import fs from 'node:fs';
import path from 'node:path';
import {
  coreDownload,
  coreList,
  coreLoginWithToken,
  corePurge,
  coreStatus,
  coreTrash,
  coreUpload,
} from '../lib/core.js';

const tokenFile = process.argv[2] || 'D:/python/token.txt';
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const config = () => ({});

const login = await coreLoginWithToken(config(), { token, save: true });
console.log('login ok:', JSON.stringify({ uid: login.uid, nickname: login.nickname, expire: login.expire, vip: login.vip }));

const status = await coreStatus(config());
console.log('status:', JSON.stringify({ loggedIn: status.loggedIn, uid: status.uid, spaceUsed: status.spaceUsed, spaceTotal: status.spaceTotal }));

const list = await coreList(config(), { parentId: 0, limit: 10 });
console.log('root items:', list?.total ?? list?.Total ?? list?.InfoList?.length);

const src = 'D:/python/_plug_test.txt';
fs.writeFileSync(src, 'hello from plugin token login ' + Date.now());
const up = await coreUpload(config(), { file: src, parentId: 0 });
console.log('upload:', JSON.stringify({ fileId: up.fileId, name: up.name, size: up.size, reused: up.reused }));

const out = 'D:/python/_plug_test_dl.txt';
try { fs.unlinkSync(out); } catch {}
const dl = await coreDownload(config(), { fileId: up.fileId, out });
console.log('download:', JSON.stringify({ fileId: dl.fileId, bytes: fs.statSync(out).size }));
console.log('roundtrip match:', fs.readFileSync(out, 'utf8') === fs.readFileSync(src, 'utf8'));

await coreTrash(config(), { fileIds: [up.fileId] });
await corePurge(config(), { fileIds: [up.fileId] });
console.log('cleanup done');
