# 更新记录

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
