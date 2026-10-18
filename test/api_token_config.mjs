// test/api_token_config.mjs — 不写会话，直接用 config.apiToken 操作
import fs from 'node:fs';
import { coreList, coreStatus, coreUpload, coreDownload, coreTrash, corePurge } from '../lib/core.js';

const token = fs.readFileSync('D:/python/token.txt', 'utf8').trim();
const config = () => ({ apiToken: token });

const status = await coreStatus(config());
console.log('status (inline token):', JSON.stringify({ loggedIn: status.loggedIn, uid: status.uid, spaceUsed: status.spaceUsed }));

const list = await coreList(config(), { parentId: 0, limit: 5 });
console.log('list total:', list?.total ?? list?.Total ?? (list?.InfoList || []).length);

fs.writeFileSync('D:/python/_inline_test.txt', 'inline apiToken ' + Date.now());
const up = await coreUpload(config(), { file: 'D:/python/_inline_test.txt', parentId: 0 });
console.log('upload:', JSON.stringify({ fileId: up.fileId, size: up.size }));

const out = 'D:/python/_inline_test_dl.txt';
try { fs.unlinkSync(out); } catch {}
await coreDownload(config(), { fileId: up.fileId, out });
console.log('roundtrip match:', fs.readFileSync(out, 'utf8') === fs.readFileSync('D:/python/_inline_test.txt', 'utf8'));

await coreTrash(config(), { fileIds: [up.fileId] });
await corePurge(config(), { fileIds: [up.fileId] });
console.log('cleaned');
