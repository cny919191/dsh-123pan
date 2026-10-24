// 云端内部拖拽（文件 → 文件夹）= 移动，回归测试
//
// 做法：用假 React 渲染插件注册的所有插槽，挑出真正带「可拖拽行 + 可放置行」的那个面板，
//       预置列表数据（一个文件夹 + 一个文件），直接调用文件行的 onDragStart 与文件夹行的 onDrop，
//       断言发出了 move 请求且参数正确（fileIds=[文件id]，parentId=文件夹id）。
import fs from 'node:fs';
import vm from 'node:vm';

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

const calls = [];
let loaded;
const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { loaded = s; } }, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  require: (n) => (n === 'react' ? fakeReact : { jsx: () => null }),
  console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URL,
  fetch: async (url, opts) => {
    const name = String(url).split('/').pop();
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ name, body });
    if (name === 'move') return { ok: true, json: async () => ({ ok: true, value: {} }) };
    if (name === 'list') return { ok: true, json: async () => ({ ok: true, value: { items: [], total: 0 } }) };
    return { ok: true, json: async () => ({ ok: true, value: null }) };
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const mod = loaded.factory(sandbox.require);

const regs = [];
mod.apply({
  effect: (fn) => { fn(); return () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, fn) => fn(), register: (o, c) => { regs.push({ o, c }); return () => {}; } },
});

const sessions = (sel) => sel({ byId: { s1: { cwd: 'D:\\python', retainedBy: { mainView: 1 } } } });

function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
  const p = node.props || {};
  if (typeof p.onDragStart === 'function') out.drag.push(node);
  if (typeof p.onDrop === 'function') out.drop.push(node);
  (node.children || []).forEach((n) => collect(n, out));
}

let side = null;
let dragRows = [];
let dropRows = [];
for (const r of regs) {
  hookIndex = 0;
  hookState.length = 0;
  hookState[0] = { loading: false, value: { loggedIn: true, workspaceRoot: 'D:\\python', account: { uid: 1, nickname: 't' } }, error: null };
  hookState[1] = 0;
  hookState[2] = [{ id: 0, name: '根目录' }];
  hookState[3] = {
    loading: false,
    total: 2,
    error: null,
    items: [
      { fileId: 1, name: 'a 文件夹', type: 1, size: 0 },
      { fileId: 2, name: 'b.txt', type: 0, size: 10 },
    ],
  };
  hookState[4] = false;
  hookState[5] = '';
  hookState[6] = null;
  hookState[7] = '';
  let tree = null;
  try {
    tree = r.c({ useSessions: sessions });
  } catch {
    continue;
  }
  const found = { drag: [], drop: [] };
  collect(tree, found);
  if (found.drag.length && found.drop.length) {
    side = r;
    dragRows = found.drag;
    dropRows = found.drop;
    break;
  }
}

if (!side) {
  console.log('✗ 没有面板渲染出「可拖拽 + 可放置」的行');
  process.exit(1);
}
console.log(`✓ 面板 ${side.o.name}：可拖拽行 ${dragRows.length} 个，可放置行 ${dropRows.length} 个`);

const ev = () => ({
  prevented: false,
  stopped: false,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
  dataTransfer: { effectAllowed: '', dropEffect: '', setData() {} },
});

// 行顺序：先是文件夹 a（id=1），再是文件 b（id=2）；拖文件、放到文件夹上
const srcRow = dragRows[dragRows.length - 1];
const dstRow = dropRows[0];
const startEv = ev();
srcRow.props.onDragStart(startEv);
console.log('✓ onDragStart 执行，prevented=' + startEv.prevented);

const dropEv = ev();
dstRow.props.onDrop(dropEv);
console.log('✓ onDrop 执行，prevented=' + dropEv.prevented + '，stopped=' + dropEv.stopped);

await new Promise((r) => setTimeout(r, 50));

const moveCall = calls.find((c) => c.name === 'move');
if (!moveCall) {
  console.log('✗ 没有发出 move 请求，实际调用：' + (calls.map((c) => c.name).join(', ') || '(无)'));
  process.exit(1);
}
console.log('✓ 发出 move 请求：' + JSON.stringify(moveCall.body));

const okBody = JSON.stringify(moveCall.body.fileIds) === '[2]' && Number(moveCall.body.parentId) === 1;
console.log((okBody ? '✓' : '✗') + ' 参数正确（b.txt → a 文件夹）');
process.exit(okBody ? 0 : 1);
