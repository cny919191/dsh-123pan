// 预览 UI：渲染 + 点击文件名触发 preview 请求
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const hookState = [];
let hookIndex = 0;
const effects = [];
const fakeReact = {
  createElement: (t, p, ...c) => ({ type: t, props: p ?? {}, children: c }),
  Fragment: 'Fragment',
  useState: (init) => {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; }];
  },
  useEffect: (fn) => { effects.push(fn); },
  useRef: () => ({ current: null }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
};

let lastRequest = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { sandbox.__loaded = s; } }, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  require: (n) => (n === 'react' ? fakeReact : { jsx: () => null }),
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  URL,
  fetch: async (url, init) => {
    lastRequest = { url, body: init?.body };
    return { ok: true, json: async () => ({ ok: true, value: { kind: 'text', name: 'a.txt', size: 5, text: 'hello', lines: 1 } }) };
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const mod = sandbox.__loaded.factory(sandbox.require);
let panel;
mod.apply({
  effect: (fn) => { fn(); return () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, fn) => fn(), register: (o, c) => { if (o.name === 'main') panel = c; return () => {}; } },
});

const items = [
  { fileId: 11, name: 'a.txt', size: 5, type: 0 },
  { fileId: 12, name: 'b.jpg', size: 100, type: 0 },
  { fileId: 13, name: 'c.mp4', size: 200, type: 0 },
  { fileId: 14, name: 'd.pdf', size: 300, type: 0 },
  { fileId: 15, name: 'e.bin', size: 400, type: 0 },
];

function render(previewStateValue) {
  hookIndex = 0;
  hookState.length = 0;
  hookState[0] = { loading: false, value: { loggedIn: true, workspaceRoot: 'D:\\python', account: { uid: 1, nickname: 't' } }, error: null };
  hookState[3] = { loading: false, items, total: items.length, error: null };
  hookState[12] = previewStateValue ?? null;
  return panel({ useSessions: undefined });
}

function find(tree, pred, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach((n) => find(n, pred, out)); return out; }
  if (pred(tree)) out.push(tree);
  (tree.children || []).forEach((n) => find(n, pred, out));
  return out;
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
};

// 1) 基础渲染：文件名是可点击按钮
const base = render(null);
const nameBtns = find(base, (n) => n.props?.className === 'dsp123-nameBtn');
check('文件名可点击', nameBtns.length === items.length, `count=${nameBtns.length}`);

// 2) 点击触发 preview 请求
await nameBtns[0].props.onClick();
await new Promise((r) => setTimeout(r, 10));
check(
  '点击发出 preview 请求',
  String(lastRequest?.url || '').includes('/preview') && String(lastRequest?.body || '').includes('a.txt'),
  lastRequest?.url
);
check('预览状态已写入', hookState[12]?.text === 'hello', JSON.stringify(hookState[12]).slice(0, 120));

// 3) 各类型渲染
const cases = [
  ['文本', { loading: false, kind: 'text', name: 'a.txt', text: 'hello', lines: 1 }, (t) => find(t, (n) => n.type === 'pre').length === 1],
  ['图片', { loading: false, kind: 'image', name: 'b.jpg', mediaUrl: '/m' }, (t) => find(t, (n) => n.type === 'img').length === 1],
  ['视频', { loading: false, kind: 'video', name: 'c.mp4', mediaUrl: '/m' }, (t) => find(t, (n) => n.type === 'video').length === 1],
  ['PDF', { loading: false, kind: 'pdf', name: 'd.pdf', mediaUrl: '/m' }, (t) => find(t, (n) => n.type === 'iframe').length === 1],
  ['不支持', { loading: false, kind: 'other', name: 'e.bin' }, (t) => JSON.stringify(t).includes('不支持在线预览')],
  ['加载中', { loading: true, name: 'x' }, (t) => JSON.stringify(t).includes('加载中')],
  ['错误', { loading: false, error: '读取失败' }, (t) => JSON.stringify(t).includes('读取失败')],
];
for (const [label, state, pred] of cases) {
  check(`${label}预览渲染`, pred(render(state)));
}

// 4) 媒体地址是相对同源路径
check(
  'mediaUrl 同源',
  JSON.stringify(render({ loading: false, kind: 'image', name: 'b.jpg', mediaUrl: '/api/dsh-123pan/media?id=12' })).includes('/api/dsh-123pan/media')
);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
