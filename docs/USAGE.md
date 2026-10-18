# 使用说明（使用事项）

> 面向使用者的完整说明。安装、登录、上传下载、备份、给 AI 用、常见问题、风险提示。

---

## 1. 这是什么

一个 **DeepSeek Harness（DSH）插件**，把 [123 云盘](https://www.123pan.com/) 接进 DSH：

- 在 DSH 里**登录 123 云盘**（手机号 / 邮箱 + 密码，或直接粘贴 token）
- **侧边栏面板**里浏览网盘、拖拽上传、点击下载
- 把**工作区增量备份**到云端（跳过没变的文件、保留目录结构）
- 给 **AI / 脚本**一套工具和 JSON API，直接上传下载

不需要安装 123 云盘桌面客户端，也不需要开放平台的 appid / secret。

```
DSH 插件（Node/JS） ──工具 + 设置页 + 侧栏面板──▶ 123pan-core.exe（C++ 静态链接）──▶ 123 云盘
```

网络请求、MD5、16MB 分片上传、CDN 下载、token 加解密全在 C++ 核心里；
插件层只做参数拼装与界面，不依赖 Python，也没有任何运行时依赖。

---

## 2. 安装

### 2.1 前置

| 项目 | 要求 |
|---|---|
| 操作系统 | **Windows 10 / 11（x64）** |
| DSH | 0.2.x（desktop 或 web profile 均可） |
| 核心程序 | `native/core/123pan-core.exe`（仓库内已附带，静态链接） |

### 2.2 装进 DSH

DSH 的插件从 profile 的 `package.json` 里登记。两种方式：

**方式 A：本地目录链接（推荐，便于更新）**

```powershell
# 1) 把仓库放到一个固定位置，例如 D:\plugins\dsh-123pan
# 2) 在 profile 的 node_modules 里做目录联接（junction，不需要管理员）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-123pan" "D:\plugins\dsh-123pan"
```

然后编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`：

```json
{
  "dependencies": {
    "dsh-123pan": "file:D:/plugins/dsh-123pan"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...其它 bundle...",
        "dsh-123pan"
      ]
    }
  }
}
```

**两处都要加**：`dependencies` 决定包能被解析，`dsh.profile.bundles` 决定它被加载。
只加依赖不加 bundles 是最常见的"装了没反应"原因。

**方式 B：直接从 GitHub 装**

DSH 侧栏「插件 → 添加插件」支持填 Git 地址 / 本地路径 / tgz。
若走 npm registry 形式，仓库需要先发布成 npm 包（本仓库默认不发布）。

### 2.3 重启 DSH

插件模块在启动时加载，**必须完全退出 DSH 再打开**。

> 注意：Windows 上"关窗口"不一定退出进程。用任务管理器确认 `DeepSeek Harness.exe` 全部消失，
> 或者结束主进程后再双击图标。只关窗口会出现"改了代码没生效"的假象。

### 2.4 确认装好了

- 左侧栏出现 **云朵图标**，点开是网盘面板
- 「设置 → 123 云盘」出现对应页签
- 对话里 AI 能用 `pan123_status` 等工具

---

## 3. 登录

打开「设置 → 123 云盘 → 账号」，填手机号或邮箱 + 密码，点登录。

- 密码**只用于换一次 token**，不会保存
- 拿到的 JWT 用 **Windows DPAPI** 加密后存在
  `%USERPROFILE%\.dsh\dsh-123pan\session.dat`
- 该文件拷到别的 Windows 用户/机器上**解不开**（密钥与用户绑定）

也可以让 AI 直接登录：

> 帮我登录 123 云盘，账号 138xxxxxxxx，密码 ********

或者只给 token（不交出密码）：

```bash
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/loginToken \
  -H 'content-type: application/json' \
  -d '{"token":"eyJhbGciOi...","nickname":"我的账号"}'
```

---

## 4. 侧栏面板：上传与下载

左栏点击云朵图标进入面板。

### 4.1 上传

两种方式，都会传到**当前所在目录**：

1. **把文件拖进面板**（虚线框区域）——支持多选
2. 点「选择文件」按钮

> 浏览器拿不到本地文件路径，所以拖拽上传是：浏览器读文件 → 转 base64 →
> POST 给宿主 → 宿主落成临时文件 → 交给核心上传 → 删临时文件。
> 这条路的代价是**整个文件要先进浏览器内存**：64MB 以上插件会直接拦下并提示改用路径上传。

**大文件用「按路径上传」**：拖拽区下面有一个输入框，填本机完整路径（如
`G:\93阅兵.mp4`）后点「按路径上传」或回车。宿主直接把路径交给核心分片上传，
**不经过浏览器内存**，几百 MB 到数 GB 都能传。实测 705MB 视频约 130 秒。

### 4.2 下载

点文件行右侧的「下载」。

**保存目录默认是当前工作区根目录**，面板底部可以看到并修改：

- 默认显示「自动跟随当前工作区」，在侧栏切换工作区后会自动变
- 手动编辑输入框 → 变成固定目录，旁边出现「跟随工作区」按钮，点一下恢复自动跟随

同名文件不会覆盖，会自动加 ` (1)`、` (2)`。

### 4.3 在线预览

**点文件名就能看**，不用先下载：

| 类型 | 支持格式 | 说明 |
|---|---|---|
| 文本 | `.txt .md .json .log .yml .ini .csv .py .js .ts .c .cpp .go .rs .sql .lrc ...` | 宿主拉取后解码，UTF-8 → GBK → latin1 逐级回退；2MB 上限 |
| 图片 | `.jpg .jpeg .png .gif .webp .bmp .avif` | 弹层内等比缩放 |
| 视频 | `.mp4 .webm .mkv .mov .avi` | 带播放条，**支持拖进度**（服务端转发 Range） |
| 音频 | `.mp3 .flac .wav .ogg .m4a .aac` | 带播放条 |
| PDF | `.pdf` | 用浏览器内置阅读器 |

其他类型（压缩包、Office 文档等）会提示「不支持在线预览，请下载后查看」。
按 `Esc` 或点背景关闭，点右上「关闭」也可以。

> 为什么需要代理：123 云盘直链的 `Content-Type` 一律是 `application/octet-stream`。
> `<img>` 会嗅探所以直链也能显示，但 `<video>` 依赖正确的 MIME 才能播，而且拖进度要能
> `Range`。插件因此提供同源代理 `/api/dsh-123pan/media?id=<fileId>&name=<文件名>`，
> 按扩展名补 MIME 并转发 Range（只接受 `GET/HEAD`、仅本机回环、响应带 `nosniff`）。

### 4.4 其他操作

- **新建目录**：工具栏「新建目录」
- **搜索**：输入框回车
- **回收站**：工具栏「回收站」切换；回收站里的删除是**彻底删除**
- **删除**：文件行的 `×`，默认移入回收站（可恢复）

---

## 5. 工作区备份（核心用途）

### 5.1 在对话里让 AI 做

> 把当前工作区备份到 123 云盘的 `dsh-backup/python`，先预演一遍

AI 会调用 `pan123_scan_workspace`（预演）→ 你确认后调 `pan123_backup_workspace`。

### 5.2 备份做了什么

1. 扫描工作区，跳过：`.git`、`node_modules`、`__pycache__`、`.venv`、`dist`、`build`、
   `.cache` 等目录；`*.log`、`*.tmp`、`*.pyc`、`Thumbs.db` 等文件
2. 按「相对路径 + 大小 + 修改时间」判断**是否变化**，只传变化的
3. **保留目录结构**：`sub/deep/a.txt` 会传到远端的 `sub/deep/a.txt`
4. 结果写进 `%USERPROFILE%\.dsh\dsh-123pan\backups.json`（本地清单，不含文件内容）

第二次运行会输出「未变化 N 个」，不会重复上传。

### 5.3 可调参数

在 profile 的 patch 层覆盖（都有默认值）：

```yaml
- id: dsh-123pan
  name: dsh-123pan
  config:
    defaultRemoteDir: dsh-backup/my-project  # 默认远端目录
    maxFileBytes: 209715200                  # 单文件上限（字节），默认 200MB
    maxFiles: 5000                            # 单次备份文件数上限
    ignoreDirs: ['.git', 'node_modules']      # 自定义忽略目录（整体替换）
    ignoreGlobs: ['*.log', '*.tmp']           # 自定义忽略文件名（整体替换）
    downloadDir: ''                           # 固定下载目录，留空=跟随工作区
    workspaceRoot: ''                         # 强制指定工作区，留空=自动检测
    storeDir: ''                              # 数据目录，留空=~/.dsh/dsh-123pan
    corePath: ''                              # 核心 exe 路径，留空=包内
```

---

## 6. 给 AI / 脚本用

### 6.1 Agent 工具（对话里直接用）

| 工具 | 用途 |
|---|---|
| `pan123_status` | 登录状态、容量、token 到期 |
| `pan123_login` | 账号密码登录 |
| `pan123_login_token` | 用现成 token 登录（不用交密码） |
| `pan123_logout` | 退出并清除本地会话 |
| `pan123_list` | 列目录 / 搜索 / 回收站 |
| `pan123_mkdir` | 新建目录 |
| `pan123_upload` | **按本地路径上传单个文件**（不经过浏览器，无 200MB 限制） |
| `pan123_download` | 按 fileId 下载，可指定 `dir` 或 `out` |
| `pan123_direct_link` | 取临时直链 |
| `pan123_rename` / `pan123_move` / `pan123_delete` | 改名 / 移动 / 删除 |
| `pan123_backup_workspace` | 工作区增量备份（`dryRun` 可预演） |
| `pan123_backup_status` | 查看历史备份记录 |
| `pan123_scan_workspace` | 只扫描不上传 |

**AI 不需要生成 .py 脚本**——直接给文件路径就行。

### 6.2 HTTP JSON API

插件在宿主注册了本机路由（只接受 `127.0.0.1` + POST）：

```bash
# 批量按路径上传（AI / 脚本推荐）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/uploadBatch \
  -H 'content-type: application/json' \
  -d '{"files":["D:\\work\\a.zip","D:\\work\\b.txt"],"parentId":0}'

# 下载（不传 out/dir 时落到当前工作区根目录）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/download \
  -H 'content-type: application/json' \
  -d '{"fileId":123,"name":"a.zip","dir":"D:\\work"}'

# 诊断（排查路径问题）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/diag
```

完整路由：
`status · login · loginToken · logout · list · mkdir · upload · uploadBytes · uploadBatch · download · preview · media(GET) · url · rename · move · trash · purge · version · diag · scan · backup · backups · forget`

端口就是 DSH Web GUI 的端口（运行时上下文里的那个）。

---

## 7. 常见问题

### 7.1 侧栏/设置页里看不到插件

按顺序查：

1. `dsh.profile.bundles` 里**有没有** `dsh-123pan`（最容易漏）
2. `node_modules/dsh-123pan` 是否存在（junction 有没有建对）
3. 是否**完全重启**了 DSH（不是关窗口）
4. 「插件」页里这一行有没有报错信息

### 7.2 下载失败，提示"目标目录不可写"

核心 `123pan-core.exe` 位于工作区，通常带 **Low 完整性标签**：
它能写工作区，但写不了 `%TEMP%`、`%USERPROFILE%\.dsh`、桌面这类 Medium 目录。

插件已经处理：先直连目标，失败则下到 `<工作区>\.dsh-123pan-staging\` 再由 Node 搬到目标。
若仍失败，说明目标目录连 Node 也写不了（被 ACL / 防勒索软件挡了），换一个目录。

### 7.3 下载目录没跟着工作区切换

面板每 8 秒 + 窗口获得焦点时刷新一次。若还没变，调一下 `diag`：

```bash
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/diag
```

看 `workspaceRoot` 和 `sessionCwds` 是否符合预期；也可以在 patch 里用
`workspaceRoot` 强制指定。

### 7.4 上传很快但"没传"——秒传

123 云盘按 MD5 判重。相同内容的文件之前有人传过，会直接**秒传**（不算上传流量）。
这是正常行为，`reused: true` 表示命中秒传。

### 7.5 token 过期了

JWT 有效期约 90 天（`pan123_status` 会显示到期时间）。
过期后重新登录即可；插件每次 `status` 会顺手刷新一次 token。

### 7.6 会不会触发风控

接口是 123 云盘**客户端私有 API**，不是公开开放平台接口。建议：

- 个人账号、低频自用
- 不要并发猛刷（插件本身是顺序上传）
- 不要把插件用于批量分发 / 商业用途

---

## 8. 安全与隐私

| 项目 | 处理方式 |
|---|---|
| 密码 | 只用于换一次 token，不保存、不写日志 |
| token | DPAPI 加密存本机，绑定 Windows 用户 |
| 会话文件 | `%USERPROFILE%\.dsh\dsh-123pan\session.dat` |
| HTTP 路由 | 仅本机回环 + POST + 校验 Origin / Sec-Fetch-Site |
| 备份清单 | 只记录路径/大小/时间/文件 id，不含内容 |

**不要把 `session.dat` 提交到 Git 或发给别人。**

---

## 9. 目录结构

```
dsh-123pan/
├── index.js              Host 入口：注册工具 + HTTP 桥
├── client.js             侧栏面板 + 设置页 UI（跟随宿主主题）
├── lib/
│   ├── core.js           核心进程封装（NDJSON 结果 + 进度轮询）
│   ├── backup.js         扫描、增量判定、目录结构还原
│   ├── bridge.js         本机 HTTP 桥（门禁 + 错误整形）
│   └── tools.js          Agent 工具定义
├── native/core/
│   ├── main.cpp          CLI 与 NDJSON 协议
│   ├── api.cpp           123 云盘 API
│   ├── http.cpp          HTTPS 客户端（OpenSSL + Windows 证书存储）
│   ├── winutil.cpp       UTF-8/UTF-16、DPAPI、路径工具
│   ├── json.hpp          极简 JSON
│   └── build.sh          静态构建脚本
├── locale/{zh,en}.json
├── icon.svg
└── test/                 手工验证脚本
```

---

## 10. 已知限制

- **仅 Windows**（Winsock + DPAPI + Windows 证书存储）。移植要改 `http.cpp` / `winutil.cpp` 的传输与加密层，`api.cpp` 的协议逻辑可复用。
- 下载**不支持断点续传**（123 的 CDN 直链带签名与过期时间）。
- 拖拽上传受 base64 体积限制，默认 200MB 封顶；大文件请用「按路径上传」。
- 备份不压缩，按原文件上传。
- 秒传命中时不做远端 MD5 二次校验（服务端按 etag 判定）。
