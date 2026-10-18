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
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URL, fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }),
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
console.log('注册插槽:', regs.map((r) => r.o.name).join(', '));
let ok = 0;
for (const r of regs) {
  hookIndex = 0;
  hookState.length = 0;
  hookState[0] = { loading: false, value: { loggedIn: true, workspaceRoot: 'D:\python', account: { uid: 1, nickname: 't' } }, error: null };
  try {
    r.c({ useSessions: (sel) => sel({ byId: { s1: { cwd: 'D:\python', retainedBy: { mainView: 1 } } } }) });
    ok++;
  } catch (e) {
    console.log('  X', r.o.name, e && e.message);
    console.log(String(e && e.stack).slice(0, 600));
  }
}
console.log('渲染通过 ' + ok + '/' + regs.length);
