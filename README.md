# Elysian

Elysian 是 Agent 辅助的运维工作台，用于查看主机状态并操作容器、数据库、文件和安全配置。Web 使用 React、Vite、Tailwind CSS v4；服务端使用 Bun。非 Docker 本地开发保留可复现的演示数据，Docker 运行时通过同源 API 连接真实 Docker Engine 和数据库。

## 运行

```bash
bun install
bun run dev
bun run typecheck
bun run test
bun run build
bun run preview
```

Docker 开发通过宿主 Docker socket 管理宿主容器。macOS Docker Desktop 需要把 `ELYSIAN_DOCKER_MOUNT_ROOT` 指向已共享的宿主路径；Linux 默认为 `/srv`。

```bash
ELYSIAN_DOCKER_MOUNT_ROOT=$HOME/Elysian-srv docker compose up -d
```

面板监听宿主回环地址 `127.0.0.1:48100`。挂载 Docker socket 等价于授予宿主级容器管理权限，因此不要把面板反向代理到不可信网络。当前没有用户登录或请求鉴权。`bun run test` 覆盖 server、web 和契约包。

## 数据库页

Docker 环境中的 MariaDB、MySQL、Redis 使用 `/api/databases` 和数据库协议 WebSocket。创建时必须输入明确的版本标签；缺少镜像时先拉取，再创建容器与专属持久卷，或验证现有容器的引擎、版本、管理员和普通账号后接管。MariaDB/MySQL 卡片对应逻辑库；Redis 卡片对应容器的 DB 0。访问范围分别映射到宿主回环端口、容器网络以及显式确认的所有宿主网卡端口。

普通删除只删除 SQL 逻辑库或清空 Redis DB 0，保留容器和卷。最后一个 SQL 逻辑库删除后显示空容器卡片，可复用容器或单独删除容器及专属卷；删除容器前会检查其他数据库。创建失败的登记显示待处理状态，可修复后核对。容器外部停机、删除和数据库状态变化由列表刷新反映。

数据库卡片的终端由服务端建立数据库协议连接，使用受限普通账号，不启动 Shell 或数据库命令行客户端。终端有限制输入、输出、执行时间、空闲时间和并发数；Redis 响应在协议读取阶段限制字节数，SQL 驱动按行输出并限制结果总量。普通账号仅拥有目标 SQL 库权限；Redis 普通账号使用 ACL 排除危险命令。数据库列表不返回密码；点击复制时才从服务端读取，响应禁止缓存。服务端登记与凭证保存在 `~/.Elysian/config/databases.json`，文件权限为 `0600`。

Docker 环境中的 SQLite 使用面板持久卷 `~/.Elysian/data/sqlite`：可新建空库、上传单个独立 SQLite 快照、在受限数据库协议终端内读写、下载一致性快照，以及确认后删除实际文件。上传上限为 256 MiB，单库上限为 1 GiB，托管 SQLite 总量上限为 4 GiB；WAL 模式原库须先导出独立快照。文件登记位于 `~/.Elysian/config/sqlite-databases.json`，中断的创建、上传或删除会显示待处理状态。SQLite 终端允许常用查询、增删改、表/索引/视图 DDL 与事务语句，不支持文件操作、扩展加载、触发器或虚拟表创建。非 Docker 本地开发中的 SQLite 与其他数据库仍是演示状态。

## 结构与边界

- `apps/web/`：工作台页面、store、HTTP/WebSocket 与 mock adapter。
- `apps/server/`：同源 API、Docker Engine 调用、数据库协议与本机操作。
- `packages/foundation/contracts/`：跨端类型与纯常量。
- `CONTEXT.md`、`AGENTS.md`、`docs/`：本地设计文档，不进入版本库。

没有接入真实 Kubernetes、云平台或 Agent 推理。真实数据库的账号边界与请求守卫已经实现；用户认证和多租户仍待后续完成。SQL 驱动会先解码单个结果行再执行应用侧输出截断，极端超大单行仍可能造成瞬时内存峰值；不要把此版本当作不可信用户可访问的数据库代理。所有 Docker 和数据库操作均具有真实效果，操作前应核对目标容器、版本、端口与删除确认内容。
