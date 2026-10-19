// 验证 preview 路由：视频要同时给出 directUrl（CDN 直链）与 mediaUrl（同源代理兜底）
import http from 'node:http';
import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';

const VIDEO_ID = Number(process.argv[2] || 46817330);
const VIDEO_NAME = process.argv[3] || '93阅兵.mp4';
const IMAGE_ID = 47229079;

const routes = createRoutes({ config: () => ({}), logger: console, getWorkspaceRoot: () => 'D:/python' });
const byPath = new Map(routes.map((r) => [r.path, r]));
const server = http.createServer(async (req, res) => {
  const p = String(req.url || '').split('?')[0];
  const route = byPath.get(p);
  if (!route) { res.writeHead(404); res.end(); return; }
  await route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function post(name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `http://127.0.0.1:${port}/api/dsh-123pan/${name}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf.slice(0, 300))); } });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

const list = await core.coreList({}, { limit: 30 });
const video = list.items.find((i) => i.fileId === VIDEO_ID) || { fileId: VIDEO_ID, name: VIDEO_NAME, size: 739603592 };
console.log(`视频: ${video.name} (${video.size} bytes)`);

const r = await post('preview', { fileId: video.fileId, name: video.name, size: video.size });
if (!r.ok) {
  check('preview 返回成功', false, JSON.stringify(r).slice(0, 200));
} else {
  const v = r.value;
  check('kind = video', v.kind === 'video', v.kind);
  check('mime = video/mp4', v.mime === 'video/mp4', v.mime);
  check('mediaUrl 指向同源代理', String(v.mediaUrl).includes('/api/dsh-123pan/media'), String(v.mediaUrl).slice(0, 60));
  check('directUrl 存在', typeof v.directUrl === 'string' && v.directUrl.length > 50, (v.directUrl || '').slice(0, 60));

  if (v.directUrl) {
    // 直链必须能 206（浏览器 seek 的前提）
    // 直链会先 302 跳到真正的 CDN，要跟随
    const follow = (url, headers, depth = 0) =>
      new Promise((resolve) => {
        const req = http.get(new URL(url), { headers }, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && depth < 4) {
            res.resume();
            resolve(follow(new URL(res.headers.location, url).toString(), headers, depth + 1));
            return;
          }
          resolve({ status: code, cr: res.headers['content-range'], len: res.headers['content-length'] });
          res.destroy();
          req.destroy();
        });
        req.on('error', (e) => resolve({ error: e.message }));
        setTimeout(() => resolve({ error: 'timeout' }), 15000);
      });
    const head = await follow(v.directUrl, { range: 'bytes=1000-1099' });
    check('directUrl 支持 Range', head.status === 206, `status=${head.status} ${head.cr || ''}`);
  }
}

// 图片也要有 directUrl（<img> 直连更快）
const img = await post('preview', { fileId: IMAGE_ID, name: 'bmpt2.jpg', size: 1245109 });
check('图片 directUrl 存在', Boolean(img.value?.directUrl), (img.value?.directUrl || '').slice(0, 40));

server.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
