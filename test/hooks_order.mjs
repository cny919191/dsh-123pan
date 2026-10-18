// 回归测试：组件在不同状态下 hook 调用次数必须一致
// （在提前 return 之后写 hook 会让 React 抛 "Rendered more hooks than during the previous render"，
//   表现就是面板打开后空白、列表不显示）
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let hookCalls = 0;
const hookState = [];
let hookIndex = 0;

const fakeReact = {
  createElement: (t, p, ...c) => ({ type: t, props: p ?? {}, children: c }),
  Fragment: 'Fragment',
  useState: (init) => {
    hookCalls++;
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; }];
  },
  useEffect: () => { hookCalls++; },
  useRef: () => { hookCalls++; return { current: null }; },
  useCallback: (f) => { hookCalls++; return f; },
  useMemo: (f) => { hookCalls++; return f(); },
};

const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { sandbox.__loaded = s; } }, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  require: (n) => (n === 'react' ? fakeReact : { jsx: () => null }),
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }),
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const mod = sandbox.__loaded.factory(sandbox.require);

const components = {};
mod.apply({
  effect: (fn) => { fn(); return () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: {
    inject: (n, fn) => fn(),
    register: (o, c) => { components[o.name] = c; return () => {}; },
  },
});

const items = [{ fileId: 1, name: 'a.txt', size: 5, type: 0 }];

// 每个组件准备多组状态；同一组件的所有状态必须产生相同的 hook 调用次数
const scenarios = {
  'main': [
    { label: '正在检查登录', state: { 0: { loading: true, value: null, error: null } } },
    { label: '未登录', state: { 0: { loading: false, value: { loggedIn: false }, error: null } } },
    { label: '已登录', state: { 0: { loading: false, value: { loggedIn: true, workspaceRoot: 'D:\\python', account: {} }, error: null }, 3: { loading: false, items, total: 1, error: null } } },
  ],
  'settings.section': [
    { label: '默认', state: {} },
  ],
};

function countHooks(component, stateMap) {
  hookCalls = 0;
  hookIndex = 0;
  hookState.length = 0;
  for (const [k, v] of Object.entries(stateMap)) hookState[Number(k)] = v;
  component({ useSessions: (sel) => sel({ byId: { s1: { cwd: 'D:\\python', retainedBy: { mainView: 1 } } } }) });
  return hookCalls;
}

let failures = 0;
for (const [name, list] of Object.entries(scenarios)) {
  const comp = components[name];
  if (!comp) {
    console.log(`✗ 没找到组件 ${name}`);
    failures++;
    continue;
  }
  const counts = list.map((s) => ({ label: s.label, n: countHooks(comp, s.state) }));
  const uniq = new Set(counts.map((c) => c.n));
  const ok = uniq.size === 1;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${name} hook 次数一致 — ` + counts.map((c) => `${c.label}:${c.n}`).join('  ')
  );
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
