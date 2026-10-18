# 手工验证脚本

这些脚本直接用 Node 调用插件的 `lib/`，**不经过 DSH UI**，用来验证核心链路。
运行前需要先在插件里登录（或先跑 `e2e.mjs`，它自己会登录）。

```bash
cd D:\python\plugins\dsh-123pan
node test/e2e.mjs          # 登录 / 状态 / 列目录
node test/special.mjs      # 中文文件名、空格、搜索、下载内容比对
node test/backup_test2.mjs # 工作区备份：目录结构还原 + 增量（2 次全跳过、改 1 个只传 1 个）
node test/bridge_test.mjs  # HTTP 桥：路由、门禁（非本机 403 / GET 405）
node test/ws_follow.mjs    # 工作区切换时下载目录是否自动跟随（离线渲染断言）
node test/diag.mjs         # diag 路由返回的工作区/会话/路径信息
```

注意：脚本会在 123 云盘根目录创建 `_dsh_test_backup*`、`测试 目录*` 等临时项，
并在结束时把能清理的都移入回收站 / 彻底删除。**请不要用真实业务目录做实验。**
