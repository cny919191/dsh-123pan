# dsh-123pan

把 [123 云盘](https://www.123pan.com/) 接进 DeepSeek Harness：**用手机号 / 邮箱 + 密码登录**，直接在 DSH 里上传、下载、浏览和管理网盘文件，并把工作区**增量备份**到云端。

不需要安装 123 云盘桌面客户端，也不需要开放平台的 appid / secret。

```
dsh 插件 ──工具/设置页──▶ 123pan-core.exe（C++ 静态链接）──▶ 123 云盘
```

网络请求、MD5、16MB 分片上传、CDN 下载、token 加密全部在 C++ 核心里完成；
插件层只用 Node.js 做参数拼装与 UI，**不依赖 Python，也不需要任何运行时**。

---

## 功能

| 功能 | 说明 |
|---|---|
| 手机号 / 邮箱 + 密码登录 | 密码只用于换一次 token，不落盘 |
| **API Key / Token 登录** | 直接粘贴客户端 JWT，无需账号密码；也可用配置 `apiToken` 完全免登录 |
| token 本地加密 | Windows DPAPI，绑定当前用户 |
| 自动续期 | 每次 `status` 顺手刷新 token |
| 浏览 / 搜索 | 列目录、翻页、按文件名搜索、回收站 |
| 上传 | MD5 秒传 + 16MB 分片，进度可见 |
| 下载 | 直链 + 断点无关的单流写入，受限于 CDN 能力 |
| 直链 | 取临时签名下载链接，可给外部使用 |
| 重命名 / 移动 / 删除 | 删除默认进回收站，可再彻底删除 |
| 工作区增量备份 | 跳过未变化文件、保留目录结构、可预演 |
| 侧边栏面板 | 左侧栏「123 云盘」图标，点开就是网盘文件浏览 |
| 拖拽上传 | 把文件拖进侧栏面板（或点「选择文件」）直接上传到当前目录 |
| 拖拽下载 | 点文件行的「下载」，默认存到工作区根目录，可在面板底部改 |
| 主题跟随 | 设置页与侧栏面板只用宿主主题 token，亮/暗色自动跟随 |

## 安装

### 方式一：下载 Release（推荐）

[**Releases → 下载 `dsh-123pan-vX.Y.Z.zip`**](https://github.com/cny919191/dsh-123pan/releases/latest)，解压到固定目录（例如 `D:\plugins\dsh-123pan`）。

> 这个 zip 是**插件目录**，不是安装程序，不需要运行任何 exe。

然后把它接线进 profile：

```powershell
# 1) 目录联接（不需要管理员权限）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-123pan" "D:\plugins\dsh-123pan"
```

2) 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，**两处都要加**：

```json
{
  "dependencies": { "dsh-123pan": "file:D:/plugins/dsh-123pan" },
  "dsh": { "profile": { "bundles": ["...", "dsh-123pan"] } }
}
```

3) **完全退出** DSH（任务管理器确认 `DeepSeek Harness.exe` 全部消失）再打开。

### 方式二：从源码

```bash
# 1) 在插件目录构建核心（需要 MSYS2 ucrt64 的 g++）
cd native/core
./build.sh            # Linux/macOS 下请改用对应工具链，见下文

# 2) 从本地目录安装进 DSH profile
dsh plugin --profile <profile> add /absolute/path/to/dsh-123pan
```

在 DSH 的「设置 → 插件」里确认 `dsh-123pan` 已启用，然后打开「设置 → 123 云盘」登录。

> 详细步骤（含「装了没反应」的排查）见 [docs/USAGE.md](docs/USAGE.md) §2。

### 关于核心可执行文件

`native/core/123pan-core.exe` 是用 MSYS2 ucrt64 的 g++ 编译的**静态链接**程序：

* 只依赖 Windows 系统 DLL（`ws2_32` / `crypt32` / `shell32` / `ole32`）；
* OpenSSL **静态**编入，不需要额外 DLL，也不需要 `openssl.exe`；
* TLS 根证书在运行时从 **Windows 证书存储（LOCAL_MACHINE\ROOT）**加载，
  不依赖任何 `cert.pem`，用户机器上无需额外配置。

重新构建：

```bash
# Windows（MSYS2 ucrt64）
cd native/core && ./build.sh

# 其他平台（需自行替换 OpenSSL 与 Winsock 相关部分）
g++ -O2 -std=c++17 main.cpp api.cpp http.cpp winutil.cpp -o 123pan-core -lssl -lcrypto
```

> 核心当前实现了 Windows 传输层（Winsock + DPAPI + 证书存储）。
> 移植到 Linux/macOS 需要替换 `http.cpp` 的连接层与 `winutil.cpp` 的加密/路径部分，
> 其余 API 逻辑（`api.cpp`）与协议无关，可直接复用。

> - 给人看：**[docs/USAGE.md](docs/USAGE.md)**（安装、登录、上传下载、备份、AI 工具、常见问题、安全说明）
> - 给 Agent 看：**[AGENT.md](AGENT.md)**（上传自己生成的文件时照这个做，不要生成 .py 中转脚本）

## 两种入口

| 入口 | 位置 | 用途 |
|---|---|---|
| 侧边栏面板 | 左侧栏的云朵图标 | 日常上传/下载/浏览，支持拖拽文件 |
| 设置页 | 设置 → 123 云盘 | 登录、容量、备份、关于 |

拖拽上传的实现：浏览器无法把本地路径交给宿主，所以面板把 `File` 读成 base64
`POST /api/dsh-123pan/uploadBytes`，宿主落到临时文件后交给核心上传，用完即删。
受此限制，单个文件上限取 `maxFileBytes`（默认 200MB）。

下载目录的优先级（前面的赢）：

1. 请求里的 `out`（完整文件路径）
2. 请求里的 `dir`（目录）
3. 插件配置 `downloadDir`
4. **会话工作区根目录**（默认就是这里，例如 `D:\python`）

面板底部有「下载目录」输入框：默认**自动跟随当前工作区**。
在侧栏切换工作区后，下载目录会立刻跟着变（无需重启）。手动填一个路径后会固定下来，
点旁边的「跟随工作区」按钮即可恢复自动跟随。

> ⚠️ 核心 `123pan-core.exe` 位于工作区，通常带 **Low 完整性标签**，
> 因此它**能写工作区，但写不了** `%TEMP%`、`%USERPROFILE%\.dsh`、桌面这类 Medium 目录。
> 下载因此分两步：先直连目标；若报 `cannot open output file`，
> 改为先下到 `<工作区>\.dsh-123pan-staging\`，再由 Node 搬到目标位置（Node 两边都能写）。
> 这样"下载到 .dsh"或"下载到桌面"也能正常工作。

### 工作区跟随是怎么实现的

- **客户端**订阅会话 store，取 `retainedBy.mainView > 0` 的那个会话（即主视图正在显示的会话）的 `cwd`，
  切换工作区时它会变，面板随即重算下载目录；另有 8 秒轮询 + 窗口获得焦点时刷新兜底。
- **Host** 端 `getWorkspaceRoot()` 按「最近有活动」的会话 cwd 解析（最后一条事件时间），
  供 HTTP API 使用；都取不到才退回 `workingDirectory.defaultDirectory` / 进程 cwd。

## 给 AI / 脚本的 JSON API

插件在宿主里注册了本机 HTTP 路由，AI 不需要生成任何 `.py` 脚本，直接调即可：

```bash
# 按本地路径批量上传（推荐）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/uploadBatch   -H 'content-type: application/json'   -d '{"files":["D:\work\a.zip","D:\work\b.txt"],"parentId":0}'

# 下载（不传 out/dir 时落到工作区根目录）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/download   -H 'content-type: application/json'   -d '{"fileId":123,"name":"a.zip","dir":"D:\work"}'
```

完整路由：`status · login · loginToken · logout · list · mkdir · upload · uploadBytes · uploadBatch · download · url · rename · move · trash · purge · version · scan · backup · backups · forget`

状态查询：`GET`/`POST http://127.0.0.1:<port>/api/dsh-123pan/status`（只接受 POST + 本机回环）。

### 直接用 API Key（免账号密码）

拿到 token 后有三种用法，选一种即可：

```bash
# 1) 验证并存入本地加密会话（一次，之后 upload/download/list 都能用）
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/loginToken \
  -H 'content-type: application/json' \
  -d '{"token":"eyJhbGciOiJIUzI1NiIs..."}'

# 2) 之后正常上传 / 下载
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/upload \
  -H 'content-type: application/json' \
  -d '{"file":"D:\\work\\a.zip","parentId":0}'
curl -X POST http://127.0.0.1:<port>/api/dsh-123pan/download \
  -H 'content-type: application/json' \
  -d '{"fileId":123,"name":"a.zip","dir":"D:\\work"}'

# 3) 或者完全不登录：profile 的 cordis.patch.yml 里配 apiToken
```

token 从哪来：已登录的 123 云盘桌面客户端日志
`%APPDATA%\123pan\log\YYYY-MM-DD.log` 里搜 `Token:Bearer eyJ...`。
也可以用 `pan123_login_token` 工具直接交给 agent。

> `loginToken` 会先调一次 `status` 验证 token 有效，再 DPAPI 落盘；
> 无效 token 直接报 401，不会生成坏会话。
> 用 `apiToken` 配置时 `status` 不会回写会话文件（配置只读）。

## 配置

在 profile 的 `cordis.patch.yml` 里可以覆盖（都有默认值）：

```yaml
- id: dsh-123pan
  config:
    defaultRemoteDir: dsh-backup/my-project  # 备份默认目标
    maxFileBytes: 209715200                  # 单文件上限（200MB）
    maxFiles: 5000                            # 单次备份文件数上限
    ignoreDirs: ['.git', 'node_modules']      # 自定义忽略目录
    ignoreGlobs: ['*.log', '*.tmp']           # 自定义忽略文件名
    storeDir: ''                              # 会话与清单目录（默认 $DSH_HOME/dsh-123pan）
    corePath: ''                              # 核心 exe 路径（默认包内）
    apiToken: ''                              # 直接用 API Key 当会话（免登录）
```

## 给 agent 用的工具

| 工具 | 用途 |
|---|---|
| `pan123_login` | 手机号/邮箱 + 密码登录 |
| **`pan123_login_token`** | **用 API Key / Token 登录（免密码）** |
| `pan123_status` | 登录状态、容量、token 到期时间 |
| `pan123_logout` | 清除本地会话 |
| `pan123_list` | 列目录 / 搜索 / 回收站 |
| `pan123_mkdir` | 新建目录 |
| `pan123_upload` | 上传单个文件 |
| `pan123_download` | 按文件 id 下载到本地 |
| `pan123_direct_link` | 取临时直链 |
| `pan123_rename` / `pan123_move` / `pan123_delete` | 改名 / 移动 / 删除 |
| `pan123_backup_workspace` | 工作区增量备份（支持 `dryRun` 预演） |
| `pan123_backup_status` | 查看历史备份记录 |
| `pan123_scan_workspace` | 只扫描不上传，检查忽略规则与大小限制 |

会话里可以直接说：

> 把当前工作区备份到 123 云盘的 `dsh-backup/python`，先预演一遍。

## 安全说明

* **密码不保存**：只用于调用一次登录接口，换回 JWT 后即丢弃；
  传递方式是**子进程环境变量**而不是命令行参数（命令行会出现在进程列表里）。
* **token 加密存储**：DPAPI 密文（用户级），文件在 `$DSH_HOME/dsh-123pan/session.dat`；
  拷贝到别的用户/机器上无法解密。加解密由核心的 `protect` / `unprotect` 子命令完成，
  但**落盘始终由 Node 侧执行**——因为核心子进程可能处于受限令牌，写不了用户目录。
* **接口是客户端私有 API**：不是公开开放平台接口，可能随客户端版本变化；
  仅建议个人账号低频自用，高频调用可能触发风控。
* **HTTP 桥只监听本机**：`/api/dsh-123pan/*` 仅接受回环地址 + POST，
  并校验 `Origin` / `Sec-Fetch-Site`，避免被网页跨站调用。

## 目录结构

```
dsh-123pan/
├── index.js              Host 入口：注册工具 + HTTP 桥
├── client.js             设置页 UI（跟随宿主主题）
├── lib/
│   ├── core.js           核心进程封装（NDJSON 结果 + 进度轮询）
│   ├── api.js 相关         —— 见 native/core
│   ├── backup.js         工作区扫描、增量判定、目录结构还原
│   ├── bridge.js         本机 HTTP 桥（门禁 + 错误整形）
│   └── tools.js          agent 工具定义
├── native/core/
│   ├── main.cpp          CLI 与 NDJSON 协议
│   ├── api.cpp           123 云盘 API（登录/列目录/上传/下载/回收站）
│   ├── http.cpp          HTTPS 客户端（OpenSSL + Windows 证书存储）
│   ├── winutil.cpp       UTF-8/UTF-16、DPAPI、路径工具
│   ├── json.hpp          极简 JSON（解析 + 序列化）
│   └── build.sh          静态构建脚本
├── locale/{zh,en}.json   插件标题与描述
└── icon.svg
```

## 核心 CLI 约定

`native/core/123pan-core.exe` 也可以独立使用（调试或脚本化）：

```bash
# 输出默认到 stdout；用 --ndjson <文件> 改为追加写文件
123pan-core.exe list --parent 0 --limit 10
123pan-core.exe upload --file D:\x.zip --parent 0
123pan-core.exe download --id 123 --out D:\x.zip
123pan-core.exe protect --text '{"token":"..."}'    # 输出 DPAPI 密文（base64）
```

每行一个 JSON 对象：`{"type":"progress",...}` 与 `{"type":"result","ok":...}`。
令牌可以用 `DSH_123PAN_TOKEN` 环境变量传入，或用
`login --account <账号>` 配合 `DSH_123PAN_PASSWORD`。

> `--ndjson` 与 `download --out` 是两个不同的参数：前者指定**协议输出文件**，
> 后者是**下载目标路径**。早期版本两者同名 `--out` 会造成冲突，现已改名。

## 已知限制

* 仅 Windows（核心用 Winsock + DPAPI + Windows 证书存储）。
* 下载不支持断点续传（123 的 CDN 直链带签名与过期时间）。
* 备份不做压缩，按原文件上传（云盘侧可自行压缩/去重）。
* 秒传命中时不重新计算远端 MD5 校验（服务端按 etag 判定）。

## 许可

MIT
