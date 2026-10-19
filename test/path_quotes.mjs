// 验证两件事：
//   1) 宿主能识别带外层引号的路径（"C:\...\tzh.txt" 与 “...”）
//   2) 前端点「按路径上传」时发出的路径已经去掉引号，且会轮询 uploadState
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRoutes } from '../lib/bridge.js';
import * as core from '../lib/core.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

// ---------------- A. 宿主路径清洗 ----------------
const tmp = 'D:/python/plugins/dsh-123pan/_q_test.txt';
fs.writeFileSync(tmp, 'quote-path test', 'utf8');
const quoted = '"' + tmp + '"';
const smart = '\u201c' + tmp + '\u201d';

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
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf.slice(0, 200))); } });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

const uploaded = [];
try {
  const a = await post('upload', { file: quoted, parentId: 0 });
  check('直双引号路径可上传', a.ok === true, a.ok ? `id=${a.value.fileId}` : a.message);
  if (a.ok) uploaded.push(a.value.fileId);

  const b = await post('upload', { file: smart, parentId: 0 });
  check('中文引号路径可上传', b.ok === true, b.ok ? `id=${b.value.fileId}` : b.message);
  if (b.ok) uploaded.push(b.value.fileId);

  // 文件不存在时要给出清楚的错误
  const c = await post('upload', { file: '"D:\\no\\such\\file.txt"', parentId: 0 });
  check('不存在的路径有明确报错', c.ok === false && /不存在|no such|ENOENT/i.test(String(c.message)), String(c.message).slice(0, 80));

  // ---------------- B. 前端：去引号 + 进度轮询 ----------------
  const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const hookState = [];
  let hookIndex = 0;
  const fakeReact = {
    createElement: (t, p, ...c) => ({ type: t, props: p ?? {}, children: c }),
    Fragment: 'Fragment',
    useState: (init) => {
      const i = hookIndex++;
      if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
      return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; }];
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (f) => f,
    useMemo: (f) => f(),
  };
  const requests = [];
  let sandboxMod;
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { sandboxMod = s; } }, addEventListener() {}, removeEventListener() {}, open() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    require: (n) => (n === 'react' ? fakeReact : { jsx: () => null }),
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL,
    fetch: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ url, body });
      if (url.endsWith('/uploadStart')) return { ok: true, json: async () => ({ ok: true, value: { taskId: 't1', name: 'x', total: 1000 } }) };
      if (url.endsWith('/uploadState')) return { ok: true, json: async () => ({ ok: true, value: { state: 'done', fraction: 1, bytes: 1000, total: 1000, name: 'x', result: { name: 'x', size: 1000 } } }) };
      return { ok: true, json: async () => ({ ok: true, value: { items: [], total: 0 } }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const mod = sandboxMod.factory(sandbox.require);
  let panel;
  mod.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (n, fn) => fn(), register: (o, c) => { if (o.name === 'main') panel = c; return () => {}; } },
  });

  hookIndex = 0;
  hookState.length = 0;
  hookState[0] = { loading: false, value: { loggedIn: true, workspaceRoot: 'D:/python', account: {} }, error: null };
  hookState[3] = { loading: false, items: [], total: 0, error: null };
  // 输入框里粘贴的是带引号的路径
  hookState[13] = '"D:\\video\\a.mp4"';
  const tree = panel({ useSessions: undefined });

  // 找到「按路径上传」按钮并点击
  let btn = null;
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'button' && JSON.stringify(n.children || '').includes('按路径上传')) btn = n;
    (n.children || []).forEach(walk);
  })(tree);
  check('找到「按路径上传」按钮', Boolean(btn));
  if (btn) {
    await btn.props.onClick();
    const start = requests.find((r) => r.url.endsWith('/uploadStart'));
    check('发出的路径已去掉引号', Boolean(start) && !String(start.body.file).includes('"'), JSON.stringify(start?.body?.file));
    check('走的是 uploadStart（有进度）', Boolean(start));
    check('随后轮询 uploadState', requests.some((r) => r.url.endsWith('/uploadState')));
  }
} finally {
  for (const id of uploaded) {
    try { await core.coreTrash({}, { fileIds: [id] }); await core.corePurge({}, { fileIds: [id] }); } catch { /* ignore */ }
  }
  fs.rmSync(tmp, { force: true });
  server.close();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
