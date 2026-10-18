window.__ModuleLoader__.load({
  id: 'dsh-123pan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // ---------------- 与 Host 的桥 ----------------
    const API = '/api/dsh-123pan';

    async function call(name, body) {
      const res = await fetch(`${API}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.ok === false) {
        const err = new Error(json.message || '请求失败');
        err.code = json.code;
        throw err;
      }
      return json.value ?? json;
    }

    function formatBytes(n) {
      const v0 = Number(n) || 0;
      if (v0 <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = v0;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(2)} ${units[i]}`;
    }

    /** 槽位未提供 useSessions 时的兜底：恒定返回 undefined，保持 hook 调用顺序稳定。 */
    const NO_SESSIONS_HOOK = () => undefined;

    /** notice 兜底文案：空文本时也不留一条没有字的色块。 */
    function noticeText(notice) {
      const text = String(notice?.text ?? '').trim();
      if (text) return text;
      return notice?.kind === 'ok' ? '完成' : '操作失败（未返回原因）';
    }

    // ---------------- 样式（只依赖宿主主题 token） ----------------
    const CSS = `
.dsp123{display:flex;flex-direction:column;gap:18px;font-size:13px;color:var(--dsw-alias-label-primary);}
.dsp123 h2{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dsp123 p{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.6;}
.dsp123-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:12px;}
.dsp123-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dsp123-title{font-size:14px;font-weight:600;}
.dsp123-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);}
.dsp123-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.dsp123-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}
.dsp123-stat{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);}
.dsp123-statLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.dsp123-statValue{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;}
.dsp123-input,.dsp123-select{height:34px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:13px;outline:none;min-width:0;}
.dsp123-input:focus,.dsp123-select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-alias-button-primary-dimmed);}
.dsp123-input::placeholder{color:var(--dsw-alias-label-tertiary);}
.dsp123-field{display:flex;flex-direction:column;gap:6px;flex:1 1 200px;min-width:0;}
.dsp123-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);}
.dsp123-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background 120ms ease,border-color 120ms ease;}
.dsp123-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dsp123-btn:disabled{opacity:.5;cursor:default;}
.dsp123-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent;}
.dsp123-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}
.dsp123-btnDanger{color:var(--dsw-alias-state-error-primary);}
.dsp123-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}
.dsp123-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:500;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
.dsp123-badgeOk{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary);}
.dsp123-badgeErr{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);}
.dsp123-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}
.dsp123-note{padding:9px 12px;border-radius:8px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}
.dsp123-noteErr{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary);border-left:3px solid var(--dsw-alias-state-error-primary);}
.dsp123-noteOk{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-label-primary);border-left:3px solid var(--dsw-alias-state-success-primary);}
.dsp123-noteWarn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary);border-left:3px solid var(--dsw-alias-state-warn-primary);}
.dsp123-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-skeleton);overflow:hidden;}
.dsp123-progress > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width 160ms ease;}
.dsp123-pv{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(0,0,0,.62);}
.dsp123-pvBox{display:flex;flex-direction:column;max-width:min(1100px,94vw);max-height:90vh;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.45);}
.dsp123-pvHead{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dsp123-pvBody{padding:12px;overflow:auto;display:flex;align-items:center;justify-content:center;min-width:300px;min-height:140px;}
.dsp123-pvImg{max-width:100%;max-height:76vh;object-fit:contain;display:block;}
.dsp123-pvMedia{max-width:100%;max-height:76vh;background:#000;display:block;border-radius:6px;}
.dsp123-pvAudio{width:min(520px,80vw);}
.dsp123-pvFrame{width:min(900px,88vw);height:76vh;border:0;background:#fff;border-radius:6px;}
.dsp123-pvText{margin:0;max-height:76vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary);}
.dsp123-nameBtn{padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsp123-nameBtn:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline;}
.dsp123-table{width:100%;border-collapse:collapse;font-size:12px;}
.dsp123-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;}
.dsp123-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:middle;}
.dsp123-table tr:last-child td{border-bottom:none;}
.dsp123-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;}
.dsp123-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dsp123-tab{height:32px;padding:0 12px;border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}
.dsp123-tab[data-active="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500;}
.dsp123-scroll{max-height:280px;overflow:auto;}
.dsp123-log{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px;}
`;

    // ---------------- 主面板 ----------------
    /**
     * 在线预览浮层（两个面板共用）。返回元素树；无预览内容时返回 null。
     * pv.kind: text / image / video / audio / pdf / other
     */
    function previewTree(pv, onClose) {
      if (!pv) return null;
      let body = null;
      if (pv.loading) {
        body = h('div', { className: 'dsp123-sub' }, '加载中…');
      } else if (pv.error) {
        body = h('div', { className: 'dsp123-note dsp123-noteErr' }, pv.error);
      } else if (pv.kind === 'text') {
        body = h('pre', { className: 'dsp123-pvText' }, pv.text);
      } else if (pv.kind === 'image') {
        body = h('img', { className: 'dsp123-pvImg', src: pv.mediaUrl, alt: pv.name });
      } else if (pv.kind === 'video') {
        body = h('video', { className: 'dsp123-pvMedia', src: pv.mediaUrl, controls: true, autoPlay: true });
      } else if (pv.kind === 'audio') {
        body = h('audio', { className: 'dsp123-pvAudio', src: pv.mediaUrl, controls: true, autoPlay: true });
      } else if (pv.kind === 'pdf') {
        body = h('iframe', { className: 'dsp123-pvFrame', src: pv.mediaUrl, title: pv.name });
      } else {
        body = h('div', { className: 'dsp123-sub' }, '这种格式不支持在线预览，请用「下载」保存后查看。');
      }
      const meta = pv.kind === 'text' && pv.lines ? `${pv.lines} 行` : pv.size ? formatBytes(pv.size) : '';
      return h(
        'div',
        {
          className: 'dsp123-pv',
          onClick: (e) => {
            if (e.target === e.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'dsp123-pvBox' },
          h(
            'div',
            { className: 'dsp123-pvHead' },
            h(
              'strong',
              { style: { fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              pv.name || '预览'
            ),
            meta && h('span', { className: 'dsp123-sub', style: { fontSize: 11, flex: 'none' } }, meta),
            h(
              'button',
              { className: 'dsp123-btn', style: { height: 24, padding: '0 8px', fontSize: 12, flex: 'none' }, onClick: onClose, title: '关闭（Esc）' },
              '关闭'
            )
          ),
          h('div', { className: 'dsp123-pvBody' }, body)
        )
      );
    }

    function Pan123Panel() {
      const [tab, setTab] = useState('account');
      const [status, setStatus] = useState({ loading: true, value: null, error: null });
      const [account, setAccount] = useState('');
      const [password, setPassword] = useState('');
      const [token, setToken] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);

      const refreshStatus = useCallback(async () => {
        setStatus((s) => ({ ...s, loading: true }));
        try {
          const value = await call('status');
          setStatus({ loading: false, value, error: value.error?.message ?? null });
        } catch (error) {
          setStatus({ loading: false, value: null, error: error.message });
        }
      }, []);

      useEffect(() => {
        refreshStatus();
      }, [refreshStatus]);

      const doLogin = async () => {
        if (!account.trim() || !password) {
          setNotice({ kind: 'err', text: '请填写账号和密码' });
          return;
        }
        setBusy('login');
        setNotice(null);
        try {
          const value = await call('login', { account: account.trim(), password });
          setPassword('');
          setNotice({ kind: 'ok', text: `登录成功：${value.nickname || value.uid}` });
          await refreshStatus();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doTokenLogin = async () => {
        if (!token.trim()) {
          setNotice({ kind: 'err', text: '请粘贴 API Key / token' });
          return;
        }
        setBusy('token');
        setNotice(null);
        try {
          const value = await call('loginToken', { token: token.trim() });
          setToken('');
          setNotice({ kind: 'ok', text: `已用 API Key 登录：${value.nickname || value.uid}` });
          await refreshStatus();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doLogout = async () => {
        setBusy('logout');
        setNotice(null);
        try {
          await call('logout');
          setNotice({ kind: 'ok', text: '已退出登录' });
          await refreshStatus();
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const value = status.value;
      const loggedIn = Boolean(value?.loggedIn);
      const acc = value?.account;

      return h(
        'div',
        { className: 'dsp123' },
        h('style', null, CSS),

        // 头部
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h(
            'div',
            null,
            h('h2', null, '123 云盘'),
            h('p', { style: { marginTop: 4 } }, '把工作区文件备份到 123 云盘，或直接在 DSH 里上传 / 下载 / 管理网盘文件。')
          ),
          h(
            'div',
            { className: 'dsp123-row' },
            loggedIn
              ? h(
                  'span',
                  { className: 'dsp123-badge dsp123-badgeOk' },
                  h('span', { className: 'dsp123-dot' }),
                  acc?.nickname || `uid ${acc?.uid ?? ''}`
                )
              : h('span', { className: 'dsp123-badge dsp123-badgeErr' }, h('span', { className: 'dsp123-dot' }), '未登录'),
            h(
              'button',
              { className: 'dsp123-btn', onClick: refreshStatus, disabled: status.loading },
              status.loading ? '刷新中…' : '刷新'
            )
          )
        ),

        notice &&
          h(
            'div',
            {
              className: `dsp123-note ${
                notice.kind === 'ok' ? 'dsp123-noteOk' : notice.kind === 'warn' ? 'dsp123-noteWarn' : 'dsp123-noteErr'
              }`,
              role: 'alert',
            },
            noticeText(notice)
          ),

        status.error && !loggedIn && h('div', { className: 'dsp123-note dsp123-noteWarn' }, status.error),

        // 容量
        loggedIn &&
          h(
            'div',
            { className: 'dsp123-grid' },
            stat('已用空间', formatBytes(acc?.spaceUsed)),
            stat('总空间', formatBytes(acc?.spaceTotal)),
            stat('会员', acc?.vip ? '已开通' : '普通用户'),
            stat('Token 到期', acc?.expire ? String(acc.expire).slice(0, 10) : '未知')
          ),

        // Tabs
        h(
          'div',
          { className: 'dsp123-tabs' },
          tabBtn('account', '账号', tab, setTab),
          tabBtn('browse', '网盘文件', tab, setTab),
          tabBtn('backup', '工作区备份', tab, setTab),
          tabBtn('about', '关于', tab, setTab)
        ),

        tab === 'account' && AccountTab({ loggedIn, acc, account, setAccount, password, setPassword, token, setToken, busy, doLogin, doTokenLogin, doLogout, value }),
        tab === 'browse' && h(BrowseTab, { loggedIn }),
        tab === 'backup' && h(BackupTab, { loggedIn }),
        tab === 'about' && AboutTab({ value })
      );
    }

    function stat(label, value) {
      return h(
        'div',
        { className: 'dsp123-stat' },
        h('span', { className: 'dsp123-statLabel' }, label),
        h('span', { className: 'dsp123-statValue' }, value ?? '—')
      );
    }

    /** 内联二次确认条：不阻塞渲染线程，配色也跟随主题。 */
    function ConfirmBar({ state, onCancel }) {
      if (!state) return null;
      return h(
        'div',
        {
          className: 'dsp123-note' + (state.danger ? ' dsp123-noteErr' : ' dsp123-noteWarn'),
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
          role: 'alertdialog',
        },
        h('span', null, state.text),
        h(
          'div',
          { className: 'dsp123-row' },
          h('button', { className: 'dsp123-btn', onClick: onCancel }, '取消'),
          h(
            'button',
            { className: 'dsp123-btn dsp123-btnPrimary', onClick: () => state.onConfirm?.() },
            '确定'
          )
        )
      );
    }

    function tabBtn(id, label, current, setTab) {
      return h(
        'button',
        { className: 'dsp123-tab', 'data-active': String(current === id), onClick: () => setTab(id), type: 'button' },
        label
      );
    }

    function AccountTab(props) {
      const { loggedIn, acc, account, setAccount, password, setPassword, token, setToken, busy, doLogin, doTokenLogin, doLogout, value } = props;
      return h(
        'div',
        { className: 'dsp123-card' },
        h('div', { className: 'dsp123-title' }, loggedIn ? '账号信息' : '登录 123 云盘'),
        h(
          'p',
          null,
          loggedIn
            ? '登录态已加密保存在本机（Windows DPAPI）。密码不会保存，只会用一次去换 token。'
            : '用手机号或邮箱 + 密码登录即可，无需安装 123 云盘桌面客户端。'
        ),
        !loggedIn &&
          h(
            'div',
            { className: 'dsp123-row', style: { alignItems: 'flex-end' } },
            h(
              'label',
              { className: 'dsp123-field' },
              h('span', { className: 'dsp123-label' }, '手机号 / 邮箱'),
              h('input', {
                className: 'dsp123-input',
                value: account,
                placeholder: '13800000000 或 name@example.com',
                autoComplete: 'username',
                onChange: (e) => setAccount(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') doLogin();
                },
              })
            ),
            h(
              'label',
              { className: 'dsp123-field' },
              h('span', { className: 'dsp123-label' }, '密码'),
              h('input', {
                className: 'dsp123-input',
                type: 'password',
                value: password,
                placeholder: '账号密码',
                autoComplete: 'current-password',
                onChange: (e) => setPassword(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') doLogin();
                },
              })
            ),
            h(
              'button',
              { className: 'dsp123-btn dsp123-btnPrimary', onClick: doLogin, disabled: busy === 'login' },
              busy === 'login' ? '登录中…' : '登录'
            )
          ),
        !loggedIn &&
          h(
            'div',
            { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(128,128,128,.25)' } },
            h('div', { className: 'dsp123-label', style: { marginBottom: 6 } }, '已有 API Key / Token？可直接跳过账号密码'),
            h(
              'div',
              { className: 'dsp123-row', style: { alignItems: 'flex-end' } },
              h(
                'label',
                { className: 'dsp123-field', style: { flex: 1 } },
                h('span', { className: 'dsp123-label' }, 'API Key / Token（可带 Bearer 前缀）'),
                h('input', {
                  className: 'dsp123-input',
                  value: token,
                  placeholder: 'eyJhbGciOiJIUzI1NiIs...',
                  spellCheck: false,
                  onChange: (e) => setToken(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') doTokenLogin();
                  },
                })
              ),
              h(
                'button',
                { className: 'dsp123-btn', onClick: doTokenLogin, disabled: busy === 'token' },
                busy === 'token' ? '验证中…' : '用 API Key 登录'
              )
            )
          ),
        loggedIn &&
          h(
            'div',
            { className: 'dsp123-row' },
            h('span', { className: 'dsp123-sub' }, `UID ${acc?.uid ?? '—'}`),
            h('span', { className: 'dsp123-sub' }, `账号 ${acc?.passport ?? '—'}`),
            h('span', { className: 'dsp123-sub' }, `Token 到期 ${acc?.expire ?? '—'}`),
            h('button', { className: 'dsp123-btn dsp123-btnDanger', onClick: doLogout, disabled: busy === 'logout' }, '退出登录')
          ),
        value?.corePath && h('div', { className: 'dsp123-mono' }, `核心：${value.corePath}`),
        value?.sessionPath && h('div', { className: 'dsp123-mono' }, `会话：${value.sessionPath}`)
      );
    }

    // ---------------- 网盘浏览 ----------------
    function BrowseTab({ loggedIn }) {
      const [parentId, setParentId] = useState(0);
      const [trail, setTrail] = useState([{ id: 0, name: '根目录' }]);
      const [data, setData] = useState({ loading: false, items: [], total: 0, error: null });
      const [search, setSearch] = useState('');
      const [trashed, setTrashed] = useState(false);
      const [busy, setBusy] = useState('');
      const [uploadPath, setUploadPath] = useState('');
      const [downloadPath, setDownloadPath] = useState('');
      const [mkdirOpen, setMkdirOpen] = useState(false);
      const [mkdirName, setMkdirName] = useState('');
      const [confirmState, setConfirmState] = useState(null);
      const [notice, setNotice] = useState(null);
      const [progress, setProgress] = useState(null);
      const [previewState, setPreviewState] = useState(null);

      const load = useCallback(
        async (pid, opts = {}) => {
          if (!loggedIn) return;
          setData((d) => ({ ...d, loading: true, error: null }));
          try {
            const value = await call('list', {
              parentId: pid,
              limit: 200,
              trashed: opts.trashed ?? trashed,
              search: opts.search ?? search,
            });
            setData({ loading: false, items: value.items || [], total: value.total || 0, error: null });
          } catch (error) {
            setData({ loading: false, items: [], total: 0, error: error.message });
          }
        },
        [loggedIn, trashed, search]
      );

      useEffect(() => {
        load(parentId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [parentId, loggedIn, trashed]);

      const enter = (item) => {
        setTrail((t) => [...t, { id: item.fileId, name: item.name }]);
        setParentId(item.fileId);
      };

      const goTo = (index) => {
        const next = trail.slice(0, index + 1);
        setTrail(next);
        setParentId(next[next.length - 1].id);
      };

      const doUpload = async () => {
        const file = uploadPath.trim();
        if (!file) {
          setNotice({ kind: 'err', text: '请填写本地文件路径' });
          return;
        }
        setBusy('upload');
        setNotice(null);
        setProgress({ fraction: 0, stage: '准备上传' });
        try {
          const value = await call('upload', { file, parentId });
          setNotice({ kind: 'ok', text: `${value.reused ? '秒传' : '上传'}完成：${value.name}（${formatBytes(value.size)}）` });
          setUploadPath('');
          await load(parentId);
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
          setProgress(null);
        }
      };

      const doMkdir = () => {
        setMkdirName('');
        setMkdirOpen(true);
      };

      const submitMkdir = async () => {
        const name = mkdirName.trim();
        if (!name) return;
        setBusy('mkdir');
        try {
          await call('mkdir', { name, parentId });
          setNotice({ kind: 'ok', text: `已创建目录 ${name}` });
          setMkdirOpen(false);
          setMkdirName('');
          await load(parentId);
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doDownload = async (item) => {
        const out = downloadPath.trim();
        if (!out) {
          setNotice({ kind: 'err', text: '请先在下方填写本地保存目录' });
          return;
        }
        const sep = out.includes('\\') ? '\\' : '/';
        const target = out.replace(/[\\/]+$/, '') + sep + item.name;
        setBusy(`download:${item.fileId}`);
        setNotice(null);
        try {
          const value = await call('download', { fileId: item.fileId, out: target });
          setNotice({ kind: 'ok', text: `下载完成：${value.path}（${formatBytes(value.bytes)}）` });
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doLink = async (item) => {
        setBusy(`link:${item.fileId}`);
        try {
          const value = await call('url', { fileId: item.fileId });
          setNotice({ kind: 'ok', text: `直链：${value.url}` });
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doDelete = (item, purge) => {
        const word = purge ? '彻底删除（不可恢复）' : '移入回收站';
        setConfirmState({
          text: `确定要${word}「${item.name}」吗？`,
          danger: purge,
          onConfirm: async () => {
            setConfirmState(null);
            setBusy(`del:${item.fileId}`);
            try {
              await call(purge ? 'purge' : 'trash', { fileIds: [item.fileId] });
              setNotice({ kind: 'ok', text: `已${word}：${item.name}` });
              await load(parentId);
            } catch (error) {
              setNotice({ kind: 'err', text: error.message });
            } finally {
              setBusy('');
            }
          },
        });
      };

      const openPreview = useCallback(async (item) => {
        if (!item || item.type === 1) return;
        setPreviewState({ loading: true, name: item.name, error: null });
        try {
          const value = await call('preview', { fileId: item.fileId, name: item.name, size: item.size });
          setPreviewState({ loading: false, error: null, ...value });
        } catch (error) {
          setPreviewState({ loading: false, name: item.name, error: error.message || '预览失败' });
        }
      }, []);

      const closePreview = useCallback(() => setPreviewState(null), []);

      useEffect(() => {
        if (!previewState) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') closePreview();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [previewState, closePreview]);

      if (!loggedIn) {
        return h('div', { className: 'dsp123-card' }, h('p', null, '请先在「账号」页登录 123 云盘。'));
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        notice &&
          h(
            'div',
            { className: `dsp123-note ${notice.kind === 'ok' ? 'dsp123-noteOk' : 'dsp123-noteErr'}`, role: 'alert' },
            noticeText(notice)
          ),
        h(ConfirmBar, { state: confirmState, onCancel: () => setConfirmState(null) }),
        mkdirOpen &&
          h(
            'div',
            { className: 'dsp123-note dsp123-noteWarn', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', null, '新建目录：'),
            h('input', {
              className: 'dsp123-input',
              style: { flex: '1 1 200px' },
              autoFocus: true,
              placeholder: '目录名称',
              value: mkdirName,
              onChange: (e) => setMkdirName(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') submitMkdir();
                if (e.key === 'Escape') setMkdirOpen(false);
              },
            }),
            h('button', { className: 'dsp123-btn dsp123-btnPrimary', onClick: submitMkdir, disabled: busy === 'mkdir' }, '创建'),
            h('button', { className: 'dsp123-btn', onClick: () => setMkdirOpen(false) }, '取消')
          ),
        h(
          'div',
          { className: 'dsp123-card' },
          h(
            'div',
            { className: 'dsp123-cardHead' },
            h(
              'div',
              { className: 'dsp123-row' },
              trail.map((node, index) =>
                h(
                  React.Fragment,
                  { key: `${node.id}-${index}` },
                  index > 0 && h('span', { className: 'dsp123-sub' }, '/'),
                  h(
                    'button',
                    {
                      className: 'dsp123-btn',
                      style: { height: 26, padding: '0 8px', fontSize: 12 },
                      onClick: () => goTo(index),
                    },
                    node.name
                  )
                )
              )
            ),
            h(
              'div',
              { className: 'dsp123-row' },
              h('input', {
                className: 'dsp123-input',
                style: { width: 180 },
                placeholder: '搜索文件名',
                value: search,
                onChange: (e) => setSearch(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') load(parentId, { search: e.target.value });
                },
              }),
              h('button', { className: 'dsp123-btn', onClick: () => load(parentId, { search }) }, '搜索'),
              h(
                'button',
                { className: 'dsp123-btn', onClick: () => setTrashed((v) => !v) },
                trashed ? '返回文件' : '回收站'
              ),
              !trashed && h('button', { className: 'dsp123-btn', onClick: doMkdir, disabled: busy === 'mkdir' }, '新建目录')
            )
          ),
          data.error && h('div', { className: 'dsp123-note dsp123-noteErr' }, data.error),
          h(
            'div',
            { className: 'dsp123-scroll' },
            h(
              'table',
              { className: 'dsp123-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '名称'),
                  h('th', null, '大小'),
                  h('th', null, '修改时间'),
                  h('th', { style: { textAlign: 'right' } }, '操作')
                )
              ),
              h(
                'tbody',
                null,
                data.loading && h('tr', null, h('td', { colSpan: 4, className: 'dsp123-sub' }, '加载中…')),
                !data.loading && data.items.length === 0 &&
                  h('tr', null, h('td', { colSpan: 4, className: 'dsp123-sub' }, trashed ? '回收站为空' : '此目录为空')),
                data.items.map((item) =>
                  h(
                    'tr',
                    { key: item.fileId },
                    h(
                      'td',
                      null,
                      item.type === 1
                        ? h('button', { className: 'dsp123-btn', style: { height: 24, padding: '0 8px', fontSize: 12 }, onClick: () => enter(item) }, `📁 ${item.name}`)
                        : h(
                            'button',
                            { className: 'dsp123-nameBtn', title: '点击在线预览', onClick: () => openPreview(item) },
                            `📄 ${item.name}`
                          )
                    ),
                    h('td', null, item.type === 1 ? '—' : formatBytes(item.size)),
                    h('td', { className: 'dsp123-sub' }, String(item.updateAt || '').slice(0, 19).replace('T', ' ')),
                    h(
                      'td',
                      { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                      item.type === 0 &&
                        h(
                          'button',
                          { className: 'dsp123-btn', style: { height: 24, padding: '0 8px', fontSize: 12 }, onClick: () => doDownload(item), disabled: busy === `download:${item.fileId}` },
                          '下载'
                        ),
                      item.type === 0 &&
                        h(
                          'button',
                          { className: 'dsp123-btn', style: { height: 24, padding: '0 8px', fontSize: 12 }, onClick: () => doLink(item), disabled: busy === `link:${item.fileId}` },
                          '直链'
                        ),
                      h(
                        'button',
                        {
                          className: 'dsp123-btn dsp123-btnDanger',
                          style: { height: 24, padding: '0 8px', fontSize: 12 },
                          onClick: () => doDelete(item, trashed),
                          disabled: busy === `del:${item.fileId}`,
                        },
                        trashed ? '彻底删除' : '删除'
                      )
                    )
                  )
                )
              )
            )
          ),
          h('div', { className: 'dsp123-sub' }, `共 ${data.total} 项`)
        ),

        h(
          'div',
          { className: 'dsp123-card' },
          h('div', { className: 'dsp123-title' }, '上传 / 下载'),
          h(
            'div',
            { className: 'dsp123-row', style: { alignItems: 'flex-end' } },
            h(
              'label',
              { className: 'dsp123-field' },
              h('span', { className: 'dsp123-label' }, '本地文件（绝对路径）'),
              h('input', {
                className: 'dsp123-input',
                placeholder: 'D:\\work\\report.zip',
                value: uploadPath,
                onChange: (e) => setUploadPath(e.target.value),
              })
            ),
            h(
              'button',
              { className: 'dsp123-btn dsp123-btnPrimary', onClick: doUpload, disabled: busy === 'upload' },
              busy === 'upload' ? '上传中…' : '上传到当前目录'
            )
          ),
          progress &&
            h(
              'div',
              null,
              h('div', { className: 'dsp123-sub', style: { marginBottom: 6 } }, progress.stage || '上传中'),
              h('div', { className: 'dsp123-progress' }, h('i', { style: { width: `${Math.round((progress.fraction || 0) * 100)}%` } }))
            ),
          h(
            'label',
            { className: 'dsp123-field' },
            h('span', { className: 'dsp123-label' }, '下载保存目录（点文件行的「下载」时使用）'),
            h('input', {
              className: 'dsp123-input',
              placeholder: 'D:\\downloads',
              value: downloadPath,
              onChange: (e) => setDownloadPath(e.target.value),
            })
          ),
          previewTree(previewState, closePreview)
        )
      );
    }

    // ---------------- 工作区备份 ----------------
    function BackupTab({ loggedIn }) {
      const [info, setInfo] = useState({ loading: true, value: null, error: null });
      const [remoteDir, setRemoteDir] = useState('');
      const [workspaceRoot, setWorkspaceRoot] = useState('');
      const [scan, setScan] = useState(null);
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [confirmState, setConfirmState] = useState(null);
      const [log, setLog] = useState([]);
      const [result, setResult] = useState(null);

      const loadInfo = useCallback(async () => {
        try {
          const value = await call('backups');
          setInfo({ loading: false, value, error: null });
          if (!remoteDir && value.defaultRemoteDir) setRemoteDir(value.defaultRemoteDir);
        } catch (error) {
          setInfo({ loading: false, value: null, error: error.message });
        }
      }, [remoteDir]);

      useEffect(() => {
        loadInfo();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const doScan = async () => {
        setBusy('scan');
        setNotice(null);
        try {
          const value = await call('scan', { workspaceRoot: workspaceRoot.trim() || undefined, remoteDir: remoteDir.trim() || undefined });
          setScan(value);
          setNotice({ kind: 'ok', text: `扫描完成：${value.files} 个文件，${value.pending.length} 个待上传，${value.unchanged} 个未变化` });
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doBackup = async () => {
        setBusy('backup');
        setNotice(null);
        setLog([]);
        setResult(null);
        const push = (line) => setLog((l) => [...l.slice(-200), line]);
        push(`开始备份 ${new Date().toLocaleTimeString()}`);
        try {
          const value = await call('backup', {
            workspaceRoot: workspaceRoot.trim() || undefined,
            remoteDir: remoteDir.trim() || undefined,
          });
          setResult(value);
          push(`完成：上传 ${value.uploaded}，未变化 ${value.unchanged}，失败 ${value.failed?.length ?? 0}`);
          setNotice({
            kind: value.failed?.length ? 'warn' : 'ok',
            text: `备份完成：上传 ${value.uploaded} 个，跳过未变化 ${value.unchanged} 个${
              value.failed?.length ? `，失败 ${value.failed.length} 个` : ''
            }`,
          });
          await loadInfo();
        } catch (error) {
          push(`失败：${error.message}`);
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doForget = (record) => {
        setConfirmState({
          text: `清除备份记录（不会删除云端文件）：${record.remoteDir} ← ${record.workspaceRoot}`,
          danger: true,
          onConfirm: async () => {
            setConfirmState(null);
            try {
              await call('forget', { workspaceRoot: record.workspaceRoot, remoteDir: record.remoteDir });
              setNotice({ kind: 'ok', text: '记录已清除' });
              await loadInfo();
            } catch (error) {
              setNotice({ kind: 'err', text: error.message });
            }
          },
        });
      };

      const records = info.value?.records ?? [];

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        notice &&
          h(
            'div',
            {
              className: `dsp123-note ${
                notice.kind === 'ok' ? 'dsp123-noteOk' : notice.kind === 'warn' ? 'dsp123-noteWarn' : 'dsp123-noteErr'
              }`,
              role: 'alert',
            },
            noticeText(notice)
          ),
        h(ConfirmBar, { state: confirmState, onCancel: () => setConfirmState(null) }),
        !loggedIn && h('div', { className: 'dsp123-note dsp123-noteWarn' }, '请先在「账号」页登录后再备份。'),
        h(
          'div',
          { className: 'dsp123-card' },
          h('div', { className: 'dsp123-title' }, '备份设置'),
          h(
            'p',
            null,
            '扫描工作区并把新增 / 修改过的文件上传到 123 云盘。默认跳过 .git、node_modules、缓存目录，' +
              '单文件超过 200MB 也会跳过（可在插件配置里改）。'
          ),
          h(
            'div',
            { className: 'dsp123-row', style: { alignItems: 'flex-end' } },
            h(
              'label',
              { className: 'dsp123-field' },
              h('span', { className: 'dsp123-label' }, '工作区目录（留空 = DSH 当前工作目录）'),
              h('input', {
                className: 'dsp123-input',
                placeholder: 'D:\\python',
                value: workspaceRoot,
                onChange: (e) => setWorkspaceRoot(e.target.value),
              })
            ),
            h(
              'label',
              { className: 'dsp123-field' },
              h('span', { className: 'dsp123-label' }, '云端目录'),
              h('input', {
                className: 'dsp123-input',
                placeholder: 'dsh-backup/my-project',
                value: remoteDir,
                onChange: (e) => setRemoteDir(e.target.value),
              })
            )
          ),
          h(
            'div',
            { className: 'dsp123-row' },
            h('button', { className: 'dsp123-btn', onClick: doScan, disabled: busy === 'scan' }, busy === 'scan' ? '扫描中…' : '扫描（预演）'),
            h(
              'button',
              { className: 'dsp123-btn dsp123-btnPrimary', onClick: doBackup, disabled: busy === 'backup' || !loggedIn },
              busy === 'backup' ? '备份中…' : '开始备份'
            )
          ),
          scan &&
            h(
              'div',
              null,
              h('div', { className: 'dsp123-sub', style: { marginBottom: 6 } },
                `将备份 ${scan.files} 个文件（${formatBytes(scan.bytes)}），待上传 ${scan.pending.length}，未变化 ${scan.unchanged}，跳过 ${scan.skipped.length}`),
              h(
                'div',
                { className: 'dsp123-scroll' },
                h(
                  'table',
                  { className: 'dsp123-table' },
                  h('thead', null, h('tr', null, h('th', null, '待上传文件'), h('th', null, '大小'))),
                  h(
                    'tbody',
                    null,
                    scan.pending.slice(0, 100).map((f) =>
                      h('tr', { key: f.rel }, h('td', null, f.rel), h('td', null, formatBytes(f.size)))
                    ),
                    scan.pending.length === 0 && h('tr', null, h('td', { colSpan: 2, className: 'dsp123-sub' }, '没有需要上传的文件'))
                  )
                )
              )
            ),
          log.length > 0 && h('div', { className: 'dsp123-log' }, log.map((line, i) => h('div', { key: i }, line))),
          result &&
            result.failed?.length > 0 &&
            h(
              'div',
              { className: 'dsp123-scroll' },
              h(
                'table',
                { className: 'dsp123-table' },
                h('thead', null, h('tr', null, h('th', null, '失败文件'), h('th', null, '原因'))),
                h(
                  'tbody',
                  null,
                  result.failed.map((f) => h('tr', { key: f.rel }, h('td', null, f.rel), h('td', { className: 'dsp123-sub' }, f.error)))
                )
              )
            )
        ),

        h(
          'div',
          { className: 'dsp123-card' },
          h('div', { className: 'dsp123-cardHead' }, h('div', { className: 'dsp123-title' }, '备份记录'), h('button', { className: 'dsp123-btn', onClick: loadInfo }, '刷新')),
          records.length === 0
            ? h('p', null, '还没有备份记录。')
            : h(
                'div',
                { className: 'dsp123-scroll' },
                h(
                  'table',
                  { className: 'dsp123-table' },
                  h(
                    'thead',
                    null,
                    h('tr', null, h('th', null, '云端目录'), h('th', null, '工作区'), h('th', null, '文件数'), h('th', null, '上次运行'), h('th', null, ''))
                  ),
                  h(
                    'tbody',
                    null,
                    records.map((r) =>
                      h(
                        'tr',
                        { key: r.key },
                        h('td', null, r.remoteDir),
                        h('td', { className: 'dsp123-sub' }, r.workspaceRoot),
                        h('td', null, String(Object.keys(r.files ?? {}).length)),
                        h('td', { className: 'dsp123-sub' }, String(r.lastRun ?? '').slice(0, 19).replace('T', ' ')),
                        h(
                          'td',
                          { style: { textAlign: 'right' } },
                          h('button', { className: 'dsp123-btn dsp123-btnDanger', style: { height: 24, padding: '0 8px', fontSize: 12 }, onClick: () => doForget(r) }, '清除记录')
                        )
                      )
                    )
                  )
                )
              ),
          info.error && h('div', { className: 'dsp123-note dsp123-noteErr' }, info.error)
        )
      );
    }

    function AboutTab({ value }) {
      return h(
        'div',
        { className: 'dsp123-card' },
        h('div', { className: 'dsp123-title' }, '关于'),
        h(
          'p',
          null,
          '本插件通过 123 云盘的客户端接口工作：登录用手机号 / 邮箱 + 密码，' +
            '换到的 token 用 Windows DPAPI 加密后存在本机；密码不会被保存。'
        ),
        h(
          'p',
          null,
          '网络请求与文件分片全部由内置的 C++ 核心（123pan-core.exe）完成，' +
            '上传按 16MB 分片、MD5 秒传、下载走 CDN 直链，不依赖 Python 或第三方运行时。'
        ),
        h('p', { className: 'dsp123-sub' }, '仅建议用于个人账号自用；接口属于客户端私有 API，可能随版本变更。'),
        value?.dataDir && h('div', { className: 'dsp123-mono' }, `数据目录：${value.dataDir}`),
        value?.corePath && h('div', { className: 'dsp123-mono' }, `核心程序：${value.corePath}`)
      );
    }

    // ---------------- 侧边栏图标 ----------------
    function Pan123Icon({ size, active }) {
      const s = size || 20;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: s,
          height: s,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('path', {
          d: 'M7.2 17.5a4.2 4.2 0 0 1 .6-8.36 5.9 5.9 0 0 1 11.05 2.5 3.7 3.7 0 0 1 1.15 7.23z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12 12.2v6.1M9.6 14.6 12 12.2l2.4 2.4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    // ---------------- 侧边栏主面板（拖拽上传 / 下载到工作区） ----------------
    function Pan123SidePanel(props) {
      const [status, setStatus] = useState({ loading: true, value: null, error: null });
      const [parentId, setParentId] = useState(0);
      const [trail, setTrail] = useState([{ id: 0, name: '根目录' }]);
      const [data, setData] = useState({ loading: false, items: [], total: 0, error: null });
      const [trashed, setTrashed] = useState(false);
      const [search, setSearch] = useState('');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState('');
      const [dragOver, setDragOver] = useState(false);
      const [progress, setProgress] = useState(null);
      const [workspaceRoot, setWorkspaceRoot] = useState('');
      // 自定义下载目录：空字符串表示「跟随工作区」。
      // 用户一旦手动填了值，就固定用那个目录，直到点「跟随工作区」恢复。
      const [customDir, setCustomDir] = useState('');
      const [previewState, setPreviewState] = useState(null);
      const [confirmState, setConfirmState] = useState(null);
      const [mkdirOpen, setMkdirOpen] = useState(false);
      const [mkdirName, setMkdirName] = useState('');
      const fileInputRef = useRef(null);

      /**
       * 当前工作区：订阅会话 store，取「正在主视图显示」的那个会话的 cwd
       * （客户端以 retainedBy.mainView > 0 标记它）。
       * 这样用户在侧栏切换工作区后，下载目录会自动跟着变。
       */
      const useSessionsHook = props?.useSessions ?? NO_SESSIONS_HOOK;
      const sessionCwd = useSessionsHook((snapshot) => {
        const list = Object.values(snapshot?.byId ?? {});
        const current =
          list.find((item) => (item?.retainedBy?.mainView ?? 0) > 0) ??
          list.find((item) => typeof item?.cwd === 'string' && item.cwd);
        return typeof current?.cwd === 'string' ? current.cwd : undefined;
      });

      // 实际生效的工作区：会话 cwd 优先，其次 status 返回的，最后空
      const effectiveRoot = sessionCwd || workspaceRoot;
      // 实际下载目录：用户自定义优先，否则跟随工作区
      const downloadDir = customDir || effectiveRoot;

      const refreshStatus = useCallback(async () => {
        try {
          const value = await call('status');
          setStatus({ loading: false, value, error: value.error?.message ?? null });
          if (value?.workspaceRoot) setWorkspaceRoot(value.workspaceRoot);
        } catch (error) {
          setStatus({ loading: false, value: null, error: error.message });
        }
      }, []);

      useEffect(() => {
        refreshStatus();
        // 工作区可能随时切换：定期刷新 + 窗口重新获得焦点时刷新，
        // 保证下载目录始终跟随当前工作区（未手动指定时）。
        const timer = setInterval(refreshStatus, 8000);
        const onFocus = () => refreshStatus();
        const onVisible = () => {
          if (document.visibilityState === 'visible') refreshStatus();
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [refreshStatus]);

      const load = useCallback(
        async (pid, opts = {}) => {
          setData((d) => ({ ...d, loading: true, error: null }));
          try {
            const value = await call('list', {
              parentId: pid,
              limit: 200,
              trashed: opts.trashed ?? trashed,
              search: opts.search ?? search,
            });
            setData({ loading: false, items: value.items || [], total: value.total || 0, error: null });
          } catch (error) {
            setData({ loading: false, items: [], total: 0, error: error.message });
          }
        },
        [trashed, search]
      );

      const loggedIn = Boolean(status.value?.loggedIn);

      useEffect(() => {
        if (loggedIn) load(parentId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [parentId, loggedIn, trashed]);

      // ---- 拖拽上传 ----
      const readFileAsBase64 = (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const s = String(reader.result || '');
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : s);
          };
          reader.onerror = () => reject(new Error('读取文件失败'));
          reader.readAsDataURL(file);
        });

      const uploadFiles = async (files) => {
        if (!loggedIn) {
          setNotice({ kind: 'err', text: '请先登录 123 云盘' });
          return;
        }
        const list = Array.from(files || []);
        if (list.length === 0) return;
        setNotice(null);
        let done = 0;
        const failed = [];
        for (const file of list) {
          setBusy('upload');
          setProgress({ name: file.name, index: done + 1, total: list.length });
          try {
            const b64 = await readFileAsBase64(file);
            await call('uploadBytes', { name: file.name, data: b64, parentId });
            done++;
          } catch (error) {
            failed.push(`${file.name}: ${error.message}`);
          }
        }
        setBusy('');
        setProgress(null);
        setNotice(
          failed.length
            ? { kind: 'err', text: `上传 ${done} 个，失败 ${failed.length} 个 —— ${failed.join('；')}` }
            : { kind: 'ok', text: `已上传 ${done} 个文件` }
        );
        if (done > 0) load(parentId);
      };

      const onDrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        uploadFiles(event.dataTransfer?.files);
      };

      // ---- 下载到工作区 ----
      const download = async (item) => {
        setBusy(`dl:${item.fileId}`);
        setNotice(null);
        try {
          const value = await call('download', {
            fileId: item.fileId,
            name: item.name,
            dir: downloadDir || undefined,
            workspaceRoot: workspaceRoot || undefined,
          });
          setNotice({ kind: 'ok', text: `已下载到 ${value.path}` });
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const enter = (item) => {
        setTrail((t) => [...t, { id: item.fileId, name: item.name }]);
        setParentId(item.fileId);
      };
      const goTo = (index) => {
        const next = trail.slice(0, index + 1);
        setTrail(next);
        setParentId(next[next.length - 1].id);
      };

      const submitMkdir = async () => {
        const name = mkdirName.trim();
        if (!name) return;
        setBusy('mkdir');
        try {
          await call('mkdir', { name, parentId });
          setMkdirOpen(false);
          setMkdirName('');
          setNotice({ kind: 'ok', text: `已创建目录 ${name}` });
          load(parentId);
        } catch (error) {
          setNotice({ kind: 'err', text: error.message });
        } finally {
          setBusy('');
        }
      };

      const doDelete = (item, purge) => {
        const word = purge ? '彻底删除（不可恢复）' : '移入回收站';
        setConfirmState({
          text: `确定要${word}「${item.name}」吗？`,
          danger: purge,
          onConfirm: async () => {
            setConfirmState(null);
            setBusy(`del:${item.fileId}`);
            try {
              await call(purge ? 'purge' : 'trash', { fileIds: [item.fileId] });
              setNotice({ kind: 'ok', text: `已${word}：${item.name}` });
              load(parentId);
            } catch (error) {
              setNotice({ kind: 'err', text: error.message });
            } finally {
              setBusy('');
            }
          },
        });
      };

      if (status.loading) {
        return h('div', { className: 'dsp123' }, h('style', null, CSS), h('p', null, '正在检查登录状态…'));
      }

      if (!loggedIn) {
        return h(
          'div',
          { className: 'dsp123', style: { padding: 16 } },
          h('style', null, CSS),
          h('h2', null, '123 云盘'),
          h('p', null, '还没有登录 123 云盘。'),
          status.error && h('div', { className: 'dsp123-note dsp123-noteWarn' }, status.error),
          h('p', { className: 'dsp123-sub' }, '请在「设置 → 123 云盘」里用手机号或邮箱登录，登录后这里就能拖拽上传。')
        );
      }

      /** 打开在线预览：文本由宿主解码，图片/视频/PDF 走同源媒体代理。 */
      const openPreview = useCallback(async (item) => {
        if (!item || item.type === 1) return;
        setPreviewState({ loading: true, name: item.name, error: null });
        try {
          const value = await call('preview', {
            fileId: item.fileId,
            name: item.name,
            size: item.size,
          });
          setPreviewState({ loading: false, error: null, ...value });
        } catch (error) {
          setPreviewState({ loading: false, name: item.name, error: error.message || '预览失败' });
        }
      }, []);

      const closePreview = useCallback(() => setPreviewState(null), []);

      useEffect(() => {
        if (!previewState) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') closePreview();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [previewState, closePreview]);

      const renderPreview = () => previewTree(previewState, closePreview);


      return h(
        'div',
        {
          className: 'dsp123',
          style: { padding: '14px 16px 20px', boxSizing: 'border-box', overflow: 'auto' },
          onDragOver: (e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          },
          onDragLeave: (e) => {
            e.preventDefault();
            setDragOver(false);
          },
          onDrop,
        },
        h('style', null, CSS),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 } },
          h(
            'div',
            null,
            h('h2', null, '123 云盘'),
            h(
              'p',
              { className: 'dsp123-sub', style: { marginTop: 2 } },
              status.value?.account?.nickname || `uid ${status.value?.account?.uid ?? ''}`
            )
          ),
          h(
            'div',
            { className: 'dsp123-row' },
            h(
              'button',
              { className: 'dsp123-btn', onClick: () => fileInputRef.current?.click(), disabled: busy === 'upload' },
              busy === 'upload' ? '上传中…' : '选择文件'
            ),
            h('input', {
              ref: fileInputRef,
              type: 'file',
              multiple: true,
              style: { display: 'none' },
              onChange: (e) => {
                uploadFiles(e.target.files);
                e.target.value = '';
              },
            })
          )
        ),

        h(
          'div',
          {
            className: 'dsp123-note' + (dragOver ? ' dsp123-noteOk' : ''),
            style: {
              textAlign: 'center',
              border: `1px dashed ${dragOver ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
              background: dragOver ? 'var(--dsw-alias-state-success-tertiary)' : 'var(--dsw-alias-bg-layer-2)',
              cursor: 'pointer',
              transition: 'all 120ms ease',
            },
            onClick: () => fileInputRef.current?.click(),
          },
          dragOver ? '松手即可上传到当前目录' : '把文件拖到这里上传，或点击选择'
        ),

        progress &&
          h(
            'div',
            { className: 'dsp123-card', style: { padding: '10px 12px', gap: 6 } },
            h('div', { className: 'dsp123-sub' }, `正在上传 ${progress.index}/${progress.total}：${progress.name}`),
            h('div', { className: 'dsp123-progress' }, h('i', { style: { width: '100%' } }))
          ),

        notice &&
          h(
            'div',
            { className: `dsp123-note ${notice.kind === 'ok' ? 'dsp123-noteOk' : 'dsp123-noteErr'}`, role: 'alert' },
            noticeText(notice)
          ),
        h(ConfirmBar, { state: confirmState, onCancel: () => setConfirmState(null) }),

        mkdirOpen &&
          h(
            'div',
            { className: 'dsp123-note dsp123-noteWarn', style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('input', {
              className: 'dsp123-input',
              style: { flex: 1 },
              autoFocus: true,
              placeholder: '目录名称',
              value: mkdirName,
              onChange: (e) => setMkdirName(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') submitMkdir();
                if (e.key === 'Escape') setMkdirOpen(false);
              },
            }),
            h('button', { className: 'dsp123-btn dsp123-btnPrimary', onClick: submitMkdir }, '创建'),
            h('button', { className: 'dsp123-btn', onClick: () => setMkdirOpen(false) }, '取消')
          ),

        h(
          'div',
          { className: 'dsp123-row' },
          trail.map((node, index) =>
            h(
              React.Fragment,
              { key: `${node.id}-${index}` },
              index > 0 && h('span', { className: 'dsp123-sub' }, '/'),
              h(
                'button',
                {
                  className: 'dsp123-btn',
                  style: { height: 24, padding: '0 7px', fontSize: 11 },
                  onClick: () => goTo(index),
                },
                node.name
              )
            )
          ),
          h(
            'button',
            {
              className: 'dsp123-btn',
              style: { marginLeft: 'auto', height: 24, padding: '0 7px', fontSize: 11 },
              onClick: () => setTrashed((v) => !v),
            },
            trashed ? '返回文件' : '回收站'
          ),
          !trashed &&
            h(
              'button',
              {
                className: 'dsp123-btn',
                style: { height: 24, padding: '0 7px', fontSize: 11 },
                onClick: () => setMkdirOpen(true),
              },
              '新建目录'
            )
        ),

        h('input', {
          className: 'dsp123-input',
          placeholder: '搜索文件名后回车',
          value: search,
          onChange: (e) => setSearch(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') load(parentId, { search: e.target.value });
          },
        }),

        data.error && h('div', { className: 'dsp123-note dsp123-noteErr' }, data.error),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          data.loading && h('div', { className: 'dsp123-sub' }, '加载中…'),
          !data.loading &&
            data.items.length === 0 &&
            h('div', { className: 'dsp123-sub' }, trashed ? '回收站为空' : '此目录为空'),
          data.items.map((item) =>
            h(
              'div',
              {
                key: item.fileId,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 4px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                },
              },
              item.type === 1
                ? h(
                    'button',
                    {
                      className: 'dsp123-btn',
                      style: {
                        height: 22,
                        padding: '0 6px',
                        fontSize: 11,
                        flex: 1,
                        justifyContent: 'flex-start',
                        border: 'none',
                        background: 'none',
                      },
                      onClick: () => enter(item),
                    },
                    `📁 ${item.name}`
                  )
                : h(
                    'button',
                    {
                      className: 'dsp123-nameBtn',
                      title: '点击在线预览',
                      onClick: () => openPreview(item),
                    },
                    `📄 ${item.name}`
                  ),
              item.type === 0 &&
                h('span', { className: 'dsp123-sub', style: { flex: 'none', fontSize: 11 } }, formatBytes(item.size)),
              item.type === 0 &&
                h(
                  'button',
                  {
                    className: 'dsp123-btn',
                    style: { height: 22, padding: '0 6px', fontSize: 11, flex: 'none' },
                    onClick: () => download(item),
                    disabled: busy === `dl:${item.fileId}`,
                    title: '下载到工作区 downloads 目录',
                  },
                  busy === `dl:${item.fileId}` ? '…' : '下载'
                ),
              h(
                'button',
                {
                  className: 'dsp123-btn dsp123-btnDanger',
                  style: { height: 22, padding: '0 6px', fontSize: 11, flex: 'none' },
                  onClick: () => doDelete(item, trashed),
                  disabled: busy === `del:${item.fileId}`,
                },
                trashed ? '删除' : '×'
              )
            )
          )
        ),
        h('div', { className: 'dsp123-sub', style: { marginTop: 4 } }, `共 ${data.total} 项`),
        h(
          'div',
          { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('span', { className: 'dsp123-label' }, '下载目录'),
            customDir
              ? h(
                  'button',
                  {
                    className: 'dsp123-btn',
                    style: { height: 22, padding: '0 8px', fontSize: 11 },
                    onClick: () => setCustomDir(''),
                    title: '恢复为自动跟随当前工作区',
                  },
                  '跟随工作区'
                )
              : h('span', { className: 'dsp123-sub', style: { fontSize: 11 } }, '自动跟随当前工作区')
          ),
          h('input', {
            className: 'dsp123-input',
            value: downloadDir,
            placeholder: effectiveRoot || '留空 = 工作区根目录',
            onChange: (e) => setCustomDir(e.target.value),
            title: '下载的文件会保存到这个目录；清空或点「跟随工作区」恢复自动跟随',
          })
        ),
        renderPreview()
      );
    }

    // ---------------- 注册 ----------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const namespace = 'dsh-123pan.settings';
        ctx.effect(
          () =>
            ctx.locale.register(namespace, {
              zh: { title: '123 云盘', description: '登录 123 云盘，上传下载与工作区备份' },
              en: { title: '123 Cloud Drive', description: 'Sign in to 123pan, upload/download files and back up workspaces' },
            }),
          'dsh-123pan: locale'
        );
        const t = ctx.locale.bind(namespace);
        // settings.section 只投影 id / order / label（label 是函数，按当前语言求值），
        // 不接受 icon / locale 之类字段，多传会被忽略。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-123pan',
              order: 60,
              label: () => t('title'),
            },
            Pan123Panel
          )
        );

        // 侧边栏入口：图标 + 同名 main 面板（owner 按 sidebar 的 id 派发 main 的 key）
        const PANEL_ID = 'dsh-123pan';
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('title'),
            },
            Pan123Icon
          )
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            Pan123SidePanel
          )
        );
      },
    };
  },
});
