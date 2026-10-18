// test/bridge_token.mjs — 通过 HTTP 桥路由验证：loginToken / upload / download
import fs from 'node:fs';
import { createRoutes } from '../lib/bridge.js';

const token = fs.readFileSync('D:/python/token.txt', 'utf8').trim();
const routes = createRoutes({
  config: () => ({}),
  logger: console,
  getWorkspaceRoot: () => 'D:/python',
  getSessionCwds: () => [],
});

function routeOf(name) {
  const r = routes.find((x) => x.path.endsWith('/' + name));
  if (!r) throw new Error('route not found: ' + name);
  return r;
}

async function invoke(name, body) {
  const route = routeOf(name);
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const req = {
    method: 'POST',
    url: `/api/dsh-123pan/${name}`,
    headers: { host: '127.0.0.1:55558', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
  let status = 0;
  let out = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(buf) {
      out += buf?.toString?.() ?? '';
    },
  };
  await route.handler(req, res);
  return { status, body: JSON.parse(out) };
}

const login = await invoke('loginToken', { token });
console.log('loginToken:', login.status, JSON.stringify(login.body).slice(0, 260));

fs.writeFileSync('D:/python/_bridge_test.txt', 'bridge token upload ' + Date.now());
const up = await invoke('upload', { file: 'D:/python/_bridge_test.txt', parentId: 0 });
console.log('upload:', up.status, JSON.stringify(up.body).slice(0, 260));

const fileId = up.body?.value?.fileId;
if (fileId) {
  const dl = await invoke('download', { fileId, name: '_bridge_test_dl.txt', out: 'D:/python/_bridge_test_dl.txt' });
  console.log('download:', dl.status, JSON.stringify(dl.body).slice(0, 260));
  const same = fs.readFileSync('D:/python/_bridge_test.txt', 'utf8') === fs.readFileSync('D:/python/_bridge_test_dl.txt', 'utf8');
  console.log('roundtrip match:', same);
  const tr = await invoke('trash', { fileIds: [fileId] });
  console.log('trash:', tr.status, JSON.stringify(tr.body).slice(0, 160));
  const pg = await invoke('purge', { fileIds: [fileId] });
  console.log('purge:', pg.status, JSON.stringify(pg.body).slice(0, 160));
}
