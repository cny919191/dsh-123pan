// 预览功能端到端：/preview（文本解码）+ /media（MIME / Range / 302 跟随）
// 依赖：_p_utf8.txt / _p_gbk.txt 由外部先准备好（Node 的 Buffer 不支持 gbk 编码）
import http from 'node:http';
import fs from 'node:fs';
import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';

const cfg = {};
const routes = createRoutes({ config: () => cfg, logger: console, getWorkspaceRoot: () => 'D:/python' });
const byPath = new Map(routes.map((r) => [r.path, r]));

const server = http.createServer(async (req, res) => {
  const path = String(req.url || '').split('?')[0];
  const route = byPath.get(path);
  if (!route) {
    res.writeHead(404);
    res.end('no route');
    return;
  }
  await route.handler(req, res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/dsh-123pan`;

function post(name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${base}/${name}`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error(buf.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function getMedia(id, name, range) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (range) headers.range = range;
    http
      .get(`${base}/media?id=${id}&name=${encodeURIComponent(name)}`, { headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

const utf8Path = 'D:/python/plugins/dsh-123pan/_p_utf8.txt';
const gbkPath = 'D:/python/plugins/dsh-123pan/_p_gbk.txt';
if (!fs.existsSync(utf8Path) || !fs.existsSync(gbkPath)) {
  console.log('缺少 _p_utf8.txt / _p_gbk.txt，请先生成');
  process.exit(1);
}

const cleanup = [];
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

try {
  const up1 = await core.coreUpload(cfg, { file: utf8Path, parentId: 0 });
  const up2 = await core.coreUpload(cfg, { file: gbkPath, parentId: 0 });
  cleanup.push(up1.fileId, up2.fileId);

  // 文本预览（UTF-8 与 GBK 都要正确解码）
  for (const [label, up] of [['UTF-8', up1], ['GBK  ', up2]]) {
    const r = await post('preview', { fileId: up.fileId, name: up.name, size: up.bytes });
    const text = r.value?.text ?? '';
    check(
      `${label} 文本预览`,
      r.ok && r.value.kind === 'text' && text.includes('中文') && text.includes('line2'),
      `bytes=${r.value?.size} 首行=${JSON.stringify(text.split('\n')[0])}`
    );
  }

  // 图片 → mediaUrl
  const img = await post('preview', { fileId: 47229079, name: 'bmpt2.jpg', size: 1245109 });
  check('图片预览', img.ok && img.value.kind === 'image', `mime=${img.value?.mime}`);

  // PDF
  const pdf = await post('preview', { fileId: 46871223, name: '2026年中考英语适应卷-试卷.pdf', size: 780878 });
  check('PDF 预览', pdf.ok && pdf.value.kind === 'pdf', `mime=${pdf.value?.mime}`);

  // 媒体代理：整段
  const full = await getMedia(47229079, 'bmpt2.jpg');
  const isJpeg = full.body[0] === 0xff && full.body[1] === 0xd8;
  check(
    'media 整段',
    full.status === 200 && full.headers['content-type'] === 'image/jpeg' && isJpeg && full.body.length === 1245109,
    `status=${full.status} type=${full.headers['content-type']} len=${full.body.length}`
  );

  // 媒体代理：Range
  const part = await getMedia(47229079, 'bmpt2.jpg', 'bytes=100-199');
  check(
    'media Range',
    (part.status === 206 || part.status === 200) && part.body.length === 100,
    `status=${part.status} len=${part.body.length} content-range=${part.headers['content-range']}`
  );

  // 文本不应走媒体代理（mime 按扩展名给 text/plain）
  const txtMedia = await getMedia(up1.fileId, up1.name);
  check(
    '文本 media MIME',
    txtMedia.headers['content-type'] === 'text/plain',
    `type=${txtMedia.headers['content-type']} len=${txtMedia.body.length}`
  );
} finally {
  for (const id of cleanup) {
    try {
      await core.coreTrash(cfg, { fileIds: [id] });
      await core.corePurge(cfg, { fileIds: [id] });
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(utf8Path, { force: true });
  fs.rmSync(gbkPath, { force: true });
  server.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}
