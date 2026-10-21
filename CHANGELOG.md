# 更新记录

## 1.3.5.1

**隐私修复：移除测试文件里硬编码的第三方账号**

- 4 个测试脚本（`bridge_test` / `e2e` / `special` / `backup_test2`）与新增的
  `move` 测试里，原本直接写死了一个手机号当「测试账号」+ 明文密码。
- 现已全部改为**从环境变量读取**（`PAN123_TEST_ACCOUNT` / `PAN123_TEST_PASSWORD`），
  缺变量时直接退出并提示，不再有任何默认值。
- 同时把文档里出现的本机用户名路径改成 `<用户名>` 占位符。

**提醒**：跑这些测试会登录并改写插件已保存的会话（`session.dat` 只存一个账号），
所以务必用你自己的测试账号，跑完如需回到原账号要重新登录。

## 1.3.5

**修复：移动文件到其它目录无效（静默成功）**

- `/api/file/mod_pid` 的请求体字段名一直写错了：
  旧代码发 `{"driveId":0,"fileIds":[123],"toParentFileId":456}`，
  正确形式是 `{"fileIdList":[{"FileId":123}],"parentFileId":456}`。
- 更麻烦的是**接口对错误字段返回 `code: 0`**，所以 `pan123_move` /
  `POST /api/file/move` 一直回「已移动 N 项」，但文件根本没动 —— 属于静默失真，
  比报错更难排查。
- 现在移动真能用了：可以把根目录散落的文件归档进子目录、批量按类别归位。
- 只改请求体，不涉及凭据、路径或其它接口。

**新增测试**

- `test/move.mjs`：上传探针文件 → 移动到子目录 → 在目标目录列表里校验到它，
  并确认根目录不再出现（防止再退回「静默成功」）。

## 1.3.4

**修复：粘贴带引号的路径识别不出来**

- 资源管理器右键「复制文件地址」得到的是 `"C:\Users\<用户名>\Desktop\tzh.txt"`，
  带一对双引号，之前会被当成文件名的一部分 → 报「文件不存在」。
- 现在宿主与前端都会剥掉成对的外层引号（含中文 `“ ”`、`‘ ’`、`「 」`、`【 】`、反引号），
  覆盖上传、批量上传、下载目录等所有路径入口。
- 文件不存在时改为中文提示「本地文件不存在：<路径>」，不再抛 `local file not found`。

**新增：按路径上传显示真实进度**

- 新增 `uploadStart` / `uploadState` 两条路由：上传在宿主里异步跑，前端每 0.5 秒轮询。
- 界面显示 `已传 / 总计`（如 `16.00 MB / 60.00 MB`）+ 百分比 + 当前阶段
  （计算 MD5 → 申请上传 → 申请分片地址 → 上传分片 → 提交完成）。
- 进度来自核心按分片上报的真实数值，不是估算。
- 侧栏与设置页两处上传都接了。

**新增测试**

- `test/path_quotes.mjs`：直引号 / 中文引号路径可上传、前端发出的路径已去引号、会轮询进度
- `test/progress.mjs`：60MB 文件端到端，断言 bytes 递增、最终 bytes==total、云端大小一致

## 1.3.3

**修复：视频预览拖不动进度条（无法从 11:00 跳到 12:00）**

- 视频/音频改用 **CDN 直链 + `<video><source type=…>`**：
  `type` 属性让浏览器按声明的 MIME 解码，不必依赖响应头
  （123 直链一律 `application/octet-stream`，`<video>` 认不了）；
  Range 由 CDN 原生处理，拖动最稳。加载失败自动回退同源代理。
- `preview` 路由新增 `directUrl` 字段；预览弹层右上角新增**「新窗口」**按钮，
  可在浏览器原生播放器里打开（拖动最可靠，兜底方案）。
- 侧栏「按路径上传」占位文字改为「大文件超过 64MB 请用完整路径上传」。

**已排除的排查方向（写下来免得重查）**
- 该 mp4 是 faststart（`ftyp` → `moov` 在文件头），本身可流式跳转
- CDN 直链支持 Range：`bytes=443762155-` → 206 + 正确 `content-range`
- 同源代理经过运行中的 DSH 也返回 206 + 正确 `content-range`
  ⇒ 问题不在 Range 链路，在 `<video>` 的 MIME 嗅探 / 媒体栈

**新增测试**：`test/preview_direct.mjs`（校验 directUrl 存在且支持 Range）

## 1.3.2

**新增：侧栏「按路径上传」**

- 大文件拖拽会失败：浏览器要把整个文件读进内存转 base64，705 MB 的文件读出来是空的，
  宿主收到空内容就回「文件内容为空」。
- 侧栏拖拽区下面新增一行「按路径上传」输入框：直接填本机完整路径（如 `G:\93阅兵.mp4`），
  宿主按路径交给核心分片上传，不经过浏览器内存。
- 拖拽超过 **64 MB** 时直接提示改用路径上传，不再白等一遍内存转码。
- 实测：`G:\93阅兵.mp4`（739,603,592 字节 / 705 MB）按路径上传 **130 秒**成功，
  云端 size 与本地逐字节一致。

**说明**：拖拽上传仍然适合几十 MB 以内的文件；几百 MB 请一律用按路径上传。


## 1.3.1

**修复：1.3.0 打开侧栏面板后空白、文件列表不显示**

- 原因：预览用的 3 个 hook（2 个 useCallback + 1 个 useEffect）写在了
  `if (status.loading) return …` / `if (!loggedIn) return …` **之后**。
  首次渲染走提前 return（少调 3 个 hook），状态到位后走到完整分支（多调 3 个 hook），
  React 报 "Rendered more hooks than during the previous render"，整个面板崩掉。
- 修法：把这 3 个 hook 移到所有提前 return 之前。
- 新增 `test/hooks_order.mjs`：同一组件用「加载中 / 未登录 / 已登录」三种状态各渲染一次，
  要求 hook 调用次数完全一致 —— 专门拦这类问题（本次修复前是 21 vs 24）。

## 1.3.0

**新增：在线预览（文本 / 图片 / 视频 / 音频 / PDF）**

- 侧栏面板与设置页的文件名现在可点击，弹层直接看内容，不用先下载
- 文本由宿主拉取并解码（UTF-8 → GBK → latin1 逐级回退），2MB 上限
- 图片/视频/音频/PDF 走**同源媒体代理** `/api/dsh-123pan/media`
  - 123 的直链 `Content-Type` 是 `application/octet-stream`，`<video>` 认不了，
    代理按扩展名补正确 MIME
  - 转发 `Range`，支持视频拖进度（实测 206 + `content-range`）
  - 直链缓存 15 分钟，避免拖动时反复换签名 URL
- 只接受 `GET/HEAD`，仅本机回环；响应带 `nosniff`，不执行远端内容

**测试**
- `test/preview.mjs`：UTF-8/GBK 文本解码、图片 MIME、Range 206、PDF
- `test/preview_ui.mjs`：点击触发请求、7 种预览状态渲染

## 1.2.0

**新增：三种「直接给 API Key」的用法，都不需要账号密码**

1. 工具 `pan123_login_token` —— agent 可粘贴 token 登录，先 `status` 验证再落盘
2. 设置页「已有 API Key / Token？」输入框 + `loginToken` 路由
3. 配置 `apiToken` —— 完全不写 `session.dat`，适合 CI / 脚本 / 多账号

**细节**
- `coreLoginWithToken()`：去掉可选的 `Bearer ` 前缀 → 调 `status` 验证 →
  成功才 DPAPI 落盘；token 无效直接返回 401，不会存坏会话
- `runWithSession()` / `coreStatus()` 支持「会话文件优先、`apiToken` 兜底」
- 用 `apiToken` 时 `status` **不会**回写会话文件（避免只读配置被写盘）
- token 可以用客户端日志里的那串 JWT：
  `%APPDATA%\123pan\log\*.log` → 搜 `Token:Bearer eyJ...`

**实测（2026-10-18）**
- `pan123_login_token` → uid 1819333115，上传 43 B → 下载 → 内容一致 → 删除
- HTTP 桥 `loginToken` → `upload` → `download` → `trash` → `purge` 全链路通过
- `config.apiToken` 免登录模式：列表 / 上传 / 下载 / 删除 全部通过

## 1.1.0

**新增**
- 侧边栏面板：左栏云朵图标 + 主面板文件浏览
- 拖拽上传（File → base64 → 宿主临时文件 → 核心上传）
- 下载目录**自动跟随当前工作区**，支持手动指定与一键恢复跟随
- `uploadBatch` 路由，AI/脚本可直接批量上传本地路径
- `diag` 路由，输出工作区解析、会话 cwd、核心路径等诊断信息

**修复**
- 红条无文字：错误文案颜色与背景同色系导致不可见 → 改用正常前景色 + 左侧色条
- 下载默认目录误取 profile 目录 → 改用会话 `cwd`
- 下载到 `.dsh`/桌面/Temp 失败：核心 exe 带 Low 完整性标签写不了 Medium 目录
  → 直连失败时改由工作区暂存 + Node 搬运

## 1.0.0

首个可用版本。

**功能**
- 手机号 / 邮箱 + 密码登录，token 用 Windows DPAPI 加密保存在本机
- 网盘浏览、搜索、回收站、新建目录
- 上传（MD5 秒传 + 16MB 分片）、下载、直链、重命名、移动、删除
- 工作区增量备份：跳过未变化文件、**保留目录结构**、可预演
- 14 个 agent 工具 + 设置页 UI（跟随宿主主题，亮/暗色自适应）

**实现要点**
- 网络、MD5、分片、DPAPI、TLS 全在 C++ 核心（静态链接，无运行时依赖）
- TLS 根证书取 Windows 证书存储（LOCAL_MACHINE\ROOT），不依赖 cert.pem
- 会话文件由 Node 写入、核心加解密，规避受限令牌写不了用户目录的问题
- 子进程协议走独立 NDJSON 文件（`--ndjson`），不用管道 stdio

**已修复的问题（开发期实测发现）**
- `std::wstring(path.begin(), path.end())` 造成中文路径打不开 → 改用 `MultiByteToWideChar`
- 下载 CDN 同时返回 Content-Length 与 chunked，按 chunked 解析会把正文当块头 → 有长度时按定长读
- 分片上传用错端点/字段（`s3_upload_object/auth` 只能取单片）→ 多片改用 `s3_repare_upload_parts_batch` + 大写 `StorageNode`
- 完成接口缺 `fileSize` / `isMultipart` 导致 5053 → 补齐
- 备份时子目录文件全落到根目录、同名互相覆盖 → 按相对路径逐级建目录
- `--ndjson` 与 `download --out` 同名冲突 → 协议输出参数改名 `--ndjson`
- 子进程 stdout 重定向与业务文件 fd 撞号，把协议行写进下载文件 → 强制用 `--ndjson`
- `settings.section` 多传了不存在的 `icon` / `locale` 字段 → 去掉
