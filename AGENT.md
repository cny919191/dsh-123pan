# AGENT.md —— 给 Agent 的上传指南

> 如果你是一个 AI agent，需要把自己生成的文件传到 123 云盘，**看这一页就够了**。
> 结论先行：**不要生成 `.py` / `.ps1` 之类的中转脚本，直接调用工具。**

---

## 0. 一句话流程

```
写出文件  →  pan123_upload(file=路径)  →  pan123_list 校验  →  （按需）pan123_delete
```

---

## 1. 绝对不要做的事

| ❌ 不要 | 为什么 |
|---|---|
| 写 `upload.py` / `curl` 脚本再执行 | 工具已经封装好签名、分片、MD5、重试；脚本只会多一层失败面 |
| 把文件内容塞进命令行参数 | 中文、引号、换行会被 shell 吞掉 |
| 用拖拽上传的 `uploadBytes` 传大文件 | 那条路走 base64，默认 200MB 封顶，且更慢 |
| 直接猜 `parentId` | 目录 id 是数字且每个账号不同，必须先用 `pan123_list` 查 |
| 上传后不做校验就删本地 | 先 `pan123_list` 看 size 对不对 |

---

## 2. 标准写法

### 2.1 上传单个文件（最常用）

```jsonc
// 1) 你先把内容写到本地
//    D:\python\reports\2026-10-18-summary.md

// 2) 调工具（path 可以是绝对路径，也可以是相对会话工作区的路径）
pan123_upload({ "file": "reports/2026-10-18-summary.md" })
```

返回：

```json
{ "ok": true, "fileId": 46816904, "name": "2026-10-18-summary.md", "size": 340, "reused": false }
```

- `reused: true` 表示**秒传**（云端已有相同 MD5 的文件），这是正常的，不是没传
- 想传到子目录：先 `pan123_list({ parentId: 0 })` 找到目录 id，再传 `parentId`

### 2.2 上传到指定目录

```jsonc
// 列根目录，找目标目录 id
pan123_list({ "parentId": 0, "limit": 100 })
// → { entries: [ { fileId: 47201319, name: "reports", isDir: true }, ... ] }

// 再上传
pan123_upload({ "file": "D:\\python\\a.zip", "parentId": 47201319, "name": "a-2026-10-18.zip" })
```

### 2.3 一次传多个文件

```jsonc
// 方式 A：调用多次 pan123_upload（简单可靠，推荐 agent 用）
// 方式 B：走本机 HTTP 批量接口（脚本/外部程序用）
POST http://127.0.0.1:<DSH端口>/api/dsh-123pan/uploadBatch
{ "files": ["D:\\work\\a.zip", "D:\\work\\b.txt"], "parentId": 0 }
```

### 2.4 整个工作区增量备份

```jsonc
// 先预演（不传输），确认要传什么
pan123_backup_workspace({ "dryRun": true, "remoteDir": "dsh-backup/my-project" })

// 再真跑：只传新增/修改的，跳过未变的，保留目录结构
pan123_backup_workspace({ "remoteDir": "dsh-backup/my-project" })
```

---

## 3. 上传后自检（建议每次都做）

```jsonc
// 1) 确认存在、大小对得上
pan123_list({ "parentId": 0, "search": "summary" })

// 2) 需要更严格时：下载回来比 MD5
pan123_download({ "fileId": 46816904, "dir": "D:\\python\\_verify", "name": "verify.md" })
// 然后本地算 md5，与源文件对比
```

> 搜索只接受**关键词**：传完整文件名（尤其是 `_` 开头的长名）可能搜不到，
> 用其中一段 ASCII 词或中文词更可靠。

---

## 4. 路径与命名规则

| 场景 | 规则 |
|---|---|
| 相对路径 | 相对**会话工作区**（不是插件目录） |
| 中文 / 空格 / `#` / 括号 | 都支持，核心按 UTF-8 → UTF-16 处理 |
| 非法字符 | Windows 不允许的 `\ / : * ? " < > |` 会被替换成 `_` |
| 同名文件 | 上传按服务端 `duplicate` 规则处理；下载重名会自动加 ` (1)` |
| 大文件 | 走 `pan123_upload`（按路径直传），不要走 `uploadBytes` |

---

## 5. 常见失败与处置

| 现象 | 原因 | 处置 |
|---|---|---|
| `未登录` | 会话失效 / 新机器 | `pan123_status` 确认；必要时 `pan123_login` 或 `pan123_login_token` |
| `cannot open output file` | 目标目录对核心进程不可写（Low 完整性限制） | 换到工作区内目录；插件对下载已自动做暂存+搬运 |
| `presigned url missing` | 分片申请异常 | 重试一次；持续失败把错误原文给用户 |
| `文件不存在` | fileId 过期或来自回收站 | 重新 `pan123_list` 拿 id |
| 上传成功但列表看不到 | 传到了别的 `parentId` | 看返回值里的 name，再到对应目录 list |

---

## 6. 什么时候需要问用户

- 目标目录不明确（根目录 or 某个项目文件夹）
- 文件超过 `maxFileBytes`（默认 200MB）
- 要**删除**云端已有文件（默认只移入回收站，可恢复）
- 要**备份整个工作区**（先预演，让用户确认清单）

---

## 7. 最小可用示例（可直接照做的对话）

> 把 /tmp/report.md 上传到 123 云盘根目录，然后确认大小对不对。

agent 应当执行：

```jsonc
pan123_upload({ "file": "/tmp/report.md" })
pan123_list({ "parentId": 0, "search": "report" })
```

而不是生成 `upload.py` 再 `python upload.py`。
