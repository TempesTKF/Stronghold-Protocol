# 服务器管理后台

管理界面使用独立 HTTP 监听端口，与游戏共用进程以读取实时玩家和房间状态。
默认不开启，设置 `SP_ADMIN_CONFIG` 为 JSON 配置文件绝对路径，或通过
`startServer({ admin: { host, port, stateFile, password: { salt, hash } } })` 启用。
后台 HTML、脚本和 API 只从管理端口提供；游戏端口仅提供 `GET /api/announcement`。

## 本地启动

1. 首次运行 `node scripts/configure-admin.mjs`，隐藏输入管理员密码。配置保存在
   Git 忽略的 `.admin/config.json`，只保存 scrypt 加盐哈希。
2. 运行 `node scripts/start-admin-local.mjs`，或双击 `scripts/start-admin-local.bat`。
3. 游戏：`http://127.0.0.1:3000/`；后台：`http://127.0.0.1:3001/`。
   本地配置绑定 `127.0.0.1`。修改密码后重启服务，已有后台登录失效。

云端后台绑定地址为 `0.0.0.0`，NAT 目标为 `3001/TCP`，公网端口为 50026。
systemd 使用 `SP_ADMIN_CONFIG=/etc/stronghold-admin/config.json`；
配置中的 `stateFile` 为 `/var/lib/stronghold-admin/state.json`，升级应用目录时保留。
配置文件仅 root 和服务组可读，状态目录归服务用户所有。不要把密码配置、封禁名单或测试会话提交到 Git。
本地启动不会修改云端。公网管理建议通过 HTTPS 反向代理或 SSH
隧道访问，HTTP 本身不加密密码与会话流量。

## 功能与数据

- 在线玩家：昵称、公开 ID、IP、房间、最近活动、在线/离线保留状态。
  不返回重连 token。踢出移除房间席位并关闭连接，允许之后重新进入。
- 房间：包括私密房间，显示成员、AI、难度、当前阶段、回合和观战人数。
  关闭房间会结束该局、清理计时器及 Match，并通知成员返回大厅。
- 负载：CPU 采样占用、总/可用内存、游戏进程 RSS、游戏所在文件系统容量、
  网卡接收和发送速率。Linux 读取 `/proc`，Windows 使用 `Get-NetAdapterStatistics`。
  网速是网卡合计，可能包含其他程序及虚拟网卡；计数器不可用时显示不可用。
- 公告：保存草稿与发布分离，标题最多 120 字，正文最多 12000 字，只渲染纯文本。
  发布内容显示于标题主页和服务器大厅，每 30 秒刷新；可撤下并保留草稿。
- 封禁：默认存储重连 token 的 SHA-256 摘要；即便重启、原 token 已不在会话表，
  仍在 hello 前拒绝。匿名游戏无法仅靠身份封禁阻止清空浏览器数据产生新身份。
  勾选 IP 封禁后，连接升级时即拒绝该 IP，同 IP 的所有在线玩家也会被断开。
  管理界面提示同公网 IP 的误伤范围；不提供按昵称封禁。
- 状态默认存放 `.admin/state.json`，写入临时文件后原子替换，包含公告、封禁和最近
  200 条操作记录。重启保留状态；损坏的状态文件会阻止后台启动，避免静默丢失封禁。

## 访问控制与验证

登录令牌在管理页面的 `sessionStorage` 中保存 8 小时，通过 Authorization 请求头发送，
不使用可能跨端口共享的 Cookie。每个来源 15 分钟最多 5 次失败尝试，限制并发密码计算。
写接口只接收限长 JSON，拒绝不同 Origin 的请求；不提供 CORS。所有动态文字使用
textContent / Preact 文本节点，不将公告或玩家名字插入 HTML。密码文件不在静态挂载目录。

`test/admin.test.js` 覆盖登录、限流、端口隔离、跨源拒绝、草稿发布撤下、持久化、
房间清理、身份封禁、IP 封禁及解封。管理端口绑定失败时同时关闭游戏端口，避免半启动。
不更改模拟规则或 golden 场景。
