// 验证：工作区切换时，下载目录是否自动跟随
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
let loaded;
const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { loaded = s; } }, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  require: (n) => (n === 'react' ? fakeReact : { jsx: () => null }),
  console, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval() {},
  URL,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const mod = loaded.factory(sandbox.require);
let panel;
mod.apply({
  effect: (fn) => { fn(); return () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (n, fn) => fn(),
    register: (o, c) => { if (o.name === 'main') panel = c; return () => {}; },
  },
});

function render(cwd) {
  hookIndex = 0;
  hookState.length = 0;
  hookState[0] = { loading: false, value: { loggedIn: true, workspaceRoot: cwd, account: { uid: 1, nickname: 't' } }, error: null };
  const useSessions = (selector) => selector({ byId: { s1: { id: 's1', cwd, retainedBy: { mainView: 1 } } } });
  const tree = panel({ useSessions });
  let inputValue = null;
  const texts = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') { if (typeof n === 'string') texts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'input' && typeof n.props?.title === 'string' && n.props.title.indexOf('下载') >= 0) inputValue = n.props.value;
    if (n.children) n.children.forEach(walk);
  })(tree);
  return { texts, inputValue };
}

const a = render('D:\python');
const b = render('C:\work\project-b');
console.log('工作区 A 下载目录 =', JSON.stringify(a.inputValue));
console.log('工作区 B 下载目录 =', JSON.stringify(b.inputValue));
console.log('切换后自动跟随:', a.inputValue === 'D:\python' && b.inputValue === 'C:\work\project-b' ? '✓ 通过' : '✗ 失败');
console.log('自动跟随提示:', a.texts.indexOf('自动跟随当前工作区') >= 0 ? '✓' : '✗');
