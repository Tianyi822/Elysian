# apps/server 架构方案:Bun + Hono 承载安全与平台内存端点

本文是 apps/server 的施工图:文件树、迁移映射、硬性实现决定与测试纪律。实现者按此执行,未列出的行为一律以 `../web/src/adapters/` 现有实现为准(git mv 零行为改动)。文中「实测」均指 2026-09-22 在 bun + hono 4.13.8(`/tmp/hono-probe/verify.ts`)上的直接验证结果。

## 一、定位与边界

apps/server 是容器内本机回环服务:Bun.serve 挂 Hono 应用,监听 `127.0.0.1:48101`,承载防火墙、SSH、主机用户、文件管理四片真实主机端点与平台内存端点。浏览器不直连它,全部流量经 vite(5173)的 `server.proxy` 转发;8080 不发布宿主端口,`Dockerfile.dev` 的 EXPOSE 也不必加(它是元数据,且该端口永不映射出容器)。

本期迁入:安全三片(firewall / ssh / users)的路由、服务、解析、真实接线,以及 platformMemory 路由。本期不迁:`/api/events` SSE 事件流与 `/api/resources/history`——两者与 vite 的 mock 插件(`../web/src/adapters/sse/mockEventsPlugin.node.ts:7-13` 引 hostMetrics 的 bun:sqlite metricsStore 与 /proc 采样)同插件同生命周期,事件内容必须与页面同一份确定性数据集,迁走须先把 mock 数据层抽成共享包,超出本期「服务层零行为改动迁移」范围。后续迁移时:mock 数据集与 hostMetrics 抽到共享包后,SSE 在 Bun.serve 上以 Hono streamSSE 或原生 ReadableStream 承载,帧格式与 Last-Event-ID 重放语义不变;`/api/resources/history` 与 `/api/events` 必须一起迁,届时 vite 代理前缀扩到 `/api/resources`;server 重启后进程内重放窗口归零,客户端 EventSource 自动重连补拍,行为等价于 dev server 重启,需在测试里锚定。

## 二、进程与包形态

`package.json`:`name` 为 `@elysian/server`,`type: module`;scripts 三条——`dev` 用 `bun --watch src/index.ts`,`typecheck` 用 `tsc --noEmit -p tsconfig.json`,`test` 用 `vitest run --config vitest.config.ts && bun test src/firewall/ruleTimesStore.bun.test.ts`(照抄 `../web/package.json:9` 的模式:vitest 排除 `*.bun.test.ts`,bun test 显式点名,防 bun test 把 vitest 用例一并抓走导致失败)。dependencies 只有 `@elysian/contracts: workspace:*` 与 `hono`(锁定 `^4.13.8`,与实测版本同系);devDependencies 对齐 web 现有版本:`typescript`、`vitest`、`@types/node`。

`tsconfig.json`:extends 仓库 `../../tsconfig.base.json`(strict、noUncheckedIndexedAccess 全继承),`include` 为 `["src", "vitest.config.ts"]`,`exclude` 为 `["src/**/*.bun.test.ts"]`,`compilerOptions.types` 取 `["node"]`。`src/bun-sqlite.d.ts` 是 server 侧**新增副本**(平移 `../web/src/adapters/hostMetrics/bun-sqlite.d.ts` 的内容,供 tsc 解析 `bun:sqlite`);web 侧那份**原样保留**——SSE 插件仍引 `hostMetrics/metricsStore.ts`(bun:sqlite),web 的 bun:sqlite 依赖没有消失。因此 web 的 `tsconfig.json`、`vite.build.config.ts`、`vitest.config.ts` 三个文件**都不改**,其中「不加载含 bun:sqlite 的 dev 中间件插件」类注释继续成立(vite dev 插件链仍加载 `mockEventsPlugin.node.ts`),不得改写成「web 已无 bun:sqlite」的表述。

`vitest.config.ts`:node 环境(非 jsdom),不加载任何 vite 插件,`test.exclude` 排除 `src/**/*.bun.test.ts`。

`src/index.ts`:读装配结果,`Bun.serve({ port: SERVER_PORT, hostname: '127.0.0.1', fetch: app.fetch })`;`src/app.ts`:构造父 Hono 应用并挂载五片子应用(见第六节)。

## 三、终版文件树

```text
apps/server/
├── ARCHITECTURE.md            # 本文档
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts               # Bun.serve 挂 app,127.0.0.1:48101
    ├── app.ts                 # 父 Hono(strict:false)装配 + 五片挂载
    ├── bun-sqlite.d.ts        # server 新增副本;web 侧 hostMetrics 那份保留
    ├── middleware/
    │   ├── guard.ts           # 同源守卫中间件 + readJsonBody(Request) + sendJson/sendError
    │   └── guard.test.ts      # 19 用例随迁,Request/mini-app 驱动,断言逐字保留
    ├── shared/
    │   ├── allowedHostnames.ts   # 纯常量,零依赖;vite.config 相对导入同一份
    │   ├── errors.ts             # EndpointGuardError / InvalidRequestError / invalidRequest
    │   ├── availability.ts       # resolveAvailability(env, dockerenvExists) 四片统一判据
    │   ├── isDockerEnv.ts        # server 副本,与 web 侧互指注释;不进契约包
    │   ├── noteValidation.ts     # 备注与控制字符校验(三片共享)
    │   ├── authorizedKeys.ts     # authorized_keys 行级编辑 + passwd 解析
    │   └── authorizedKeys.test.ts
    ├── firewall/
    │   ├── firewallService.ts / .test.ts        # git mv,只改 import
    │   ├── parseUfw.ts / .test.ts               # git mv 同名
    │   ├── parseSockets.ts / .test.ts
    │   ├── pingRules.ts / .test.ts
    │   ├── scanRules.ts / .test.ts
    │   ├── forwardRules.ts / .test.ts
    │   ├── panelPort.ts                         # 无测试,git mv
    │   ├── ruleTimesStore.ts / ruleTimesStore.bun.test.ts   # bun test 显式点名
    │   ├── hostFiles.ts / hostFiles.test.ts     # 去 .node. 中缀(目录已表达 Node 边界)
    │   ├── firewallHostDeps.ts                  # createHostDeps + openRuleTimesStore + restoreIfNeeded
    │   └── firewallRoutes.ts / .test.ts         # Hono 重写
    ├── ssh/
    │   ├── sshService.ts / .test.ts
    │   ├── parseSshdConfig.ts / .test.ts
    │   ├── patchSshdConfig.ts / .test.ts
    │   ├── parseSshLog.ts / .test.ts
    │   ├── sshHostDeps.ts / .test.ts            # 测试由 api.node.test.ts 改名随迁
    │   └── sshRoutes.ts / .test.ts              # Hono 重写
    ├── users/
    │   ├── usersService.ts / .test.ts
    │   ├── parseSystemUsers.ts / .test.ts
    │   ├── usersHostDeps.ts / .test.ts          # 测试由 api.node.test.ts 改名随迁
    │   └── usersRoutes.ts / .test.ts            # Hono 重写
    ├── files/                                    # 文件管理片(新实现,非安全区迁移;方案见 docs/specs/2026-09-22-file-manager-real-implementation.md)
    │   ├── filesPaths.ts / .test.ts             # 纯路径判据:归一化、`..`/`.`/控制字符拒绝、写禁区清单
    │   ├── fileTreeWalk.ts / .test.ts           # 受限遍历原语:lstat 不跟随、深度/节点上限、剪枝/报告
    │   ├── filesService.ts / .test.ts           # 八动作编排,mock 语义逐字对齐,全部宿主访问经注入 deps
    │   ├── filesHostDeps.ts / .test.ts          # 真实接线:cp/mv/tar execFile 数组传参 + fs 原语 + noFollowFs
    │   └── filesRoutes.ts / .test.ts            # /api/files 路由,守卫链与安全区三片同构
    └── platformMemory/
        └── platformMemoryRoutes.ts / .test.ts   # Hono 重写
```

## 四、硬性实现决定(不得偏离)

以下各条都有直接证据,实现时照做,不得按直觉改写。

**D1 父 Hono 实例必须 `strict: false`。** 浏览器的用户管理 http adapter 以**带尾斜杠**的根路径请求(`../web/src/adapters/http/usersHttpAdapter.ts:113,118` 用 `` `${baseUrl}/` ``,即 `/api/security/users/`),防火墙 adapter 以**无尾斜杠**请求(`../web/src/adapters/http/firewallHttpAdapter.ts:240` 用 `requestJson(baseUrl)`)。实测(hono 4.13.8):父应用默认 strict 下 `app.route('/api/security/users', sub)` + `sub.get('/')` 时,GET `/api/security/users` → 200、GET `/api/security/users/` → **404**;给子应用设 `strict: false` 或同时注册 `''` 与 `'/'` 均不解决;唯一有效解是**父应用** `new Hono({ strict: false })`(实测双形式均 200)。app.ts 必须如此构造,并在构造处写一行中文注释说明尾斜杠适配的原因。

**D2 已知行为放宽(接受,不锚定)。** 父 strict:false 使其余端点的带尾斜杠形(如 `/api/security/firewall/toggles/`)从原 404 放宽为匹配同一路由。浏览器 adapter 不产生这些请求形,界面行为无差;路由测试以 adapter 的真实请求形为准,**不得**把放宽形写成断言。

**D3 未知端点 404 用子应用 `all('*')` 兜底,禁用 `notFound` 钩子。** 实测:挂载后子应用的 `notFound` 钩子根本不被调用——未知路径返回的是**父应用默认 404,`text/plain` 的 `404 Not Found`**,三片的中文 JSON 404 会静默丢失。`sub.all('*', handler)` 兜底可接住任意方法与深度,且实测 `c.req.path` 是**含挂载前缀的全路径**(如 `/api/security/firewall/nope/deeper`)。剥前缀的实现:每片路由文件导出自己的 `MOUNT_PATH` 常量(如 `'/api/security/firewall'`),app.ts 用同一常量挂载(单一事实),兜底 handler 里 `c.req.path.slice(MOUNT_PATH.length) || '/'` 得到相对路径,再拼 `未知防火墙端点:${method} ${path}`——`path` 必须是剥前缀后的相对路径,与现文案逐字一致(对照 `../web/src/adapters/firewallHost/api.ts:178`、`sshHost/api.ts:158`、`usersHost/api.ts:99`)。

**D4 vite 代理不得设 `changeOrigin`。** vite 的 `server.proxy` 把 `/api/security` 与 `/api/platform` 转发到 `http://127.0.0.1:48101` 时,`changeOrigin` 保持默认 `false`:转发后 Host 头仍是浏览器的 `localhost:48100`,与 Origin 一致,同源守卫放行。若设 `true`,Host 被改写为 `127.0.0.1:48101`,与 Origin 不一致,server 侧同源守卫将 403 拒掉全部写请求。`preview.proxy` 同款配置(见 D8)。

**D5 根 dev 双进程,compose command 一字不动。** 仓库根 `package.json` 的 `dev` 改为后台起 server 再前台起 web,推荐形:`sh -c 'trap "kill 0" EXIT; bun run --filter @elysian/server dev & bun run --filter @elysian/web dev'`(`kill 0` 在前台进程退出时清理同进程组的 server;实现时验证 Ctrl-C 行为,若仍有残留以 `lsof -ti:48101 | xargs kill` 清理并在验收注明)。`docker-compose.yml` 的 command **不改**——它末端执行的 `bun run dev`(docker-compose.yml:32)就是根 dev 脚本,root dev 改为双进程后容器自动双进程;若同时在 compose command 里追加 server 启动,会与 root dev 双起,第二个进程 8080 端口占用失败。server 启动失败只影响安全端点、不阻断 dev,与 sshd 同策略;8080 仅容器内回环,不新增 ports 发布。

**D6 本地单起 web 的代价写进验收。** 本地 `bun run dev` 经 D5 双进程;若绕过根脚本只起 web,`/api/platform/memory` 代理连接失败,内存徽标进 error 态(原先采 vite 进程内存恒可用)。这不是回归,是监控对象变化的自然结果。

**D7 内存徽标的监控对象语义变化要落在注释里。** 监控对象从 vite dev 进程变为 apps/server 进程(Bun.serve 的 `process.memoryUsage`)。`../web/src/components/MemoryMonitorBadge.tsx` 现有注释自称监控 dev server 进程,web 收尾时同步改写为「apps/server 进程」;迁移说明同样写清。

**D8 preview 配套成套改。** 采纳 `preview.proxy` 就必须同时让根 `preview` 双进程(同 D5 形:`sh -c 'trap "kill 0" EXIT; bun run --filter @elysian/server dev & bun run --filter @elysian/web preview'`);否则单独 `bun run preview` 时代理目标 127.0.0.1:48101 无人监听,`/api/platform/memory` 与安全端点照样失效。web 的 `preview` 在 4173 端口（preview 自带，不经 compose 发布）(`../web/package.json:8`),preview.proxy 转发前缀与目标同 server.proxy。

**D9 `parsePasswdLine` / `parseGetentPasswd` 同名导出保持两文件独立。** `shared/authorizedKeys.ts`(源 sshHost,导出 `PasswdRecord` 语义)与 `users/parseSystemUsers.ts`(源 usersHost,导出 `PasswdEntry` 语义)各自含同名导出但语义不同,**不得合并为单模块**;git mv 各自落位,`parseSystemUsers` 的 `parseKeyLines` import 指向 `shared/authorizedKeys`。

**D10 三片可用性判定归一。** `shared/availability.ts` 提供 `resolveAvailability(env: NodeJS.ProcessEnv, dockerenvExists: boolean)`:`isDockerEnv(env) && dockerenvExists`。ssh 与 users 接线(现 `sshHost/api.node.ts:20-22`、`usersHost/api.node.ts:21-23` 两处同名同语义)改为 re-export 共享函数,随迁用例断言不变;firewall 接线由现内联判据(`firewallHost/api.node.ts:58` 的 `isDockerEnv() && existsSync('/.dockerenv')`)改为调用共享函数,行为等价。三片不许各自复制判据。

**D11 `isDockerEnv` 有意双份。** server 复制 `../web/src/adapters/hostMetrics/isDockerEnv.ts`(4 行纯函数)为 `shared/isDockerEnv.ts`,两份文件头注释互指;不进契约包——它读 `process.env`,契约保持零环境依赖。这是有理由的双份,不是复制违规。

**D12 平台内存端点无容器边界、无同源守卫。** GET `/api/platform/memory` 返回 `sampleFromUsage(process.memoryUsage())`(契约上提项),非 GET 一律 405 `{ error: '只允许 GET' }`。现实现即无容器判定与同源校验(`../web/src/adapters/platformMemory/api.ts:17-23`),保持。

## 五、守卫链:顺序与文案(逐字)

安全三片的守卫链顺序固定,中文文案逐字保留(对照 `../web/src/adapters/endpointGuard/guard.ts:84-105` 与三片 api.ts 的实际顺序):

1. **可用性 503**:任意方法、含未知路径。不可用时整片子应用换成 `all('*')` 的 503 分支,文案逐字:`真实防火墙仅在 Docker 容器内可用` / `真实 SSH 管理仅在 Docker 容器内可用` / `真实用户管理仅在 Docker 容器内可用`(对照 firewallHost/api.ts:46、sshHost/api.ts:40、usersHost/api.ts:56)。
2. **同源 403**(仅非 GET/HEAD):`请求来源不允许`。Hono 化为中间件从 `c.req.raw` 取 method/headers:GET/HEAD 放行;须带 Origin 且其 host 与 Host 头一致(大小写归一,解析失败视为不匹配),Host hostname ∈ `ALLOWED_HOSTNAMES`(`127.0.0.1`、`localhost`、`[::1]`)。`use('*')` 挂在子应用,对未知路径同样先于 404 执行,与原实现 handler 顶部顺序一致。
3. **读体守卫**(路由 handler 内调用 `readJsonBody(c.req.raw)`):415 `Content-Type 必须为 application/json` → 413 `请求体过大`(申报 content-length 与流式实读字节数双拦,上限 64 KiB;必须保持 for-await 流式累计读取、实读超限即拒,**不得**改成一次性 `arrayBuffer`/`text()` 再判)→ 400 `请求体不能为空` / `请求体不是有效 JSON`。
4. **未知端点 404**:`未知防火墙端点:METHOD path` / `未知 SSH 端点:METHOD path` / `未知用户管理端点:METHOD path`,path 为剥挂载前缀后的相对路径(D3)。

错误基线:`EndpointGuardError` / `InvalidRequestError` 按自带 status 返回 4xx,其余系统侧错误一律 500;响应体统一 `{ error: message }`(Error.message 或 String(error)),content-type `application/json; charset=utf-8`,中文消息原样带给界面。sendJson/sendError 用 `c.json` / `c.body` 实现同一形状。

路由层保持薄:只做路由分发、守卫调用、请求体解析(现 api.ts 内的 `parseToggles`、`parseRuleInput`、`parsePolicy`、`parseIpRuleInput`、`parseForwardInput`、`parseScanConfigBody`、`parseRuleInputList`、`parseUserInput` 等函数**原样搬入各路由文件**)与 service 调用;业务校验留在 service 层,零行为改动。

## 六、app.ts 装配

```ts
// 形状示意(实现以此为准)
const app = new Hono({ strict: false })  // D1:users 根路径的带/无尾斜杠双形式都必须命中
app.route(FIREWALL_MOUNT, createFirewallApp(firewallDeps))   // '/api/security/firewall'
app.route(SSH_MOUNT, createSshApp(sshDeps))                   // '/api/security/ssh'
app.route(USERS_MOUNT, createUsersApp(usersDeps))             // '/api/security/users'
app.route(PLATFORM_MOUNT, createPlatformMemoryApp())          // '/api/platform'
```

MOUNT 常量从各路由文件导出、app.ts 引用,与 D3 的剥前缀同源。子应用工厂签名:`createFirewallApp(deps: { available: boolean, service?: FirewallService })` 等——`available: false` 时返回全方法 503 分支(含未知路径);`service` 可注入 fake(路由测试用),缺省由 app.ts 从 hostDeps 装配提供(上示 `firewallDeps` 即 `{ available, service }` 形)。每片子应用内部结构同构:`use('*', 同源中间件)` → 具名路由(handler 内 `readJsonBody`)→ `all('*', 剥前缀 404 兜底)`。

## 七、迁移映射总表

动作四类:**上提**(进 `@elysian/contracts`)、**拆分共享**(进 server/shared 或 middleware)、**git mv 改导入**(只改 import 路径,逻辑与测试断言零改动)、**Hono 重写**(路由层)。「先于」列是硬依赖:被标「先于三片」的项必须最先完成。

| # | 目标 | 来源 | 动作 | 要点 |
|---|---|---|---|---|
| 1 | `packages/foundation/contracts/src/security/firewall.ts`、`ssh.ts`、`users.ts` | `../web/src/contracts/adapters.ts`(`FirewallAdapter`:199-228、`SshKeyAccount`:250-255、`SshAdapter`:257-296、`UserAdapter`:302-323) | 上提 | 追加进三个**现有**文件(index.ts:32-34 已导出);import 全来自本包,零新增依赖;web 的 adapters.ts 改 `export type { ... } from '@elysian/contracts'` re-export,所有消费方 import 路径不变——若漏改 re-export,web typecheck 报接口缺失属期望内的失败信号,补齐 re-export 而不是回退。**先于三片** |
| 2 | `packages/foundation/contracts/src/platform/memory.ts`(新目录)+ index.ts 加 `export *` | `../web/src/adapters/platformMemory/types.ts:5-23`(`PlatformMemorySample`、`sampleFromUsage`) | 上提 | 类型+纯函数;web 的 types.ts 改 re-export,保留浏览器侧 `parsePlatformMemoryResponse` 与 `types.test.ts`(断言不改)。**先于 platformMemory 片** |
| 3 | `apps/server/src/shared/errors.ts` | `../web/src/adapters/endpointGuard/guard.ts:22-47` | 拆分共享 | 零依赖独立模块;三片服务与解析模块改从此处导入,语义零改动。**先于三片服务** |
| 4 | `apps/server/src/shared/allowedHostnames.ts` | 同上 guard.ts:54 | 拆分共享 | 纯常量、零依赖(不 import hono、不 import node:);middleware/guard.ts re-export;`../web/vite.config.ts:4` 改相对导入 `'../server/src/shared/allowedHostnames.ts'`(vite.config 的 typecheck 连带检查该纯常量文件,属预期,不会拖入 hono 类型)。**先于守卫中间件与 web 拆除** |
| 5 | `apps/server/src/shared/isDockerEnv.ts` | `../web/src/adapters/hostMetrics/isDockerEnv.ts` | 复制(D11) | server 副本,头注释互指;不进契约包 |
| 6 | `apps/server/src/shared/availability.ts` | `sshHost/api.node.ts:20-22`、`usersHost/api.node.ts:21-23`、`firewallHost/api.node.ts:58` | 拆分共享 | D10;随迁用例改指向共享函数,断言不变。**先于三片接线** |
| 7 | `apps/server/src/middleware/guard.ts` + `guard.test.ts` | `guard.ts:9-21,56-107` + `guard.test.ts`(19 用例) | git mv 改造 | isSameOrigin → Hono 中间件(c.req.raw 取 method/headers);readJsonBody 改收 `Request`(守卫顺序与文案见第五节,流式累计语义保留);sendJson/sendError 用 c.json 实现;测试改 Request/mini-app 驱动,断言集合与中文文案逐条保留、全绿。**先于三片路由** |
| 8 | `apps/server/src/shared/noteValidation.ts` | `../web/src/adapters/firewallHost/noteValidation.ts` | git mv 改导入 | 唯一改动:invalidRequest 改从 shared/errors 导入。**先于三片服务**(firewall/ssh/users 三方依赖) |
| 9 | `apps/server/src/shared/authorizedKeys.ts` + `.test.ts` | `../web/src/adapters/sshHost/authorizedKeys.ts` + `.test.ts` | git mv 改导入 | D9:与 parseSystemUsers 同名导出保持两文件独立。**先于 ssh/users 服务** |
| 10 | `apps/server/src/firewall/firewallService.ts` + `.test.ts` | `../web/src/adapters/firewallHost/firewallService.ts` + `.test.ts` | git mv 改导入 | 仅改三条 import(errors、contracts 接口、目录内相对路径不变) |
| 11 | `apps/server/src/firewall/{parseUfw,parseSockets,pingRules,scanRules,forwardRules,panelPort}.ts` 及各自 `.test.ts`(panelPort 无测试) | 同名文件 | git mv 改导入 | 可与 #10 并行 |
| 12 | `apps/server/src/firewall/ruleTimesStore.ts` + `ruleTimesStore.bun.test.ts` | `../web/src/adapters/firewallHost/ruleTimesStore.ts` + `.bun.test.ts` | git mv 改导入 | bun:sqlite 由 Bun 运行时提供,tsc 靠 src/bun-sqlite.d.ts 副本(见第二节);server test 脚本显式纳入 bun test |
| 13 | `apps/server/src/firewall/hostFiles.ts` + `hostFiles.test.ts` | `../web/src/adapters/firewallHost/hostFiles.node.ts` + `.node.test.ts` | git mv 改导入 | 去 `.node.` 中缀;断言不动 |
| 14 | `apps/server/src/firewall/firewallHostDeps.ts` | `../web/src/adapters/firewallHost/api.node.ts` | git mv 改导入 | execFile 接线原样平移(Bun 实现 node:child_process);restoreIfNeeded 失败不拖垮 server;内联可用性判定改调 shared/availability(#6);产出 `{ available, service }` |
| 15 | `apps/server/src/firewall/firewallRoutes.ts` + `.test.ts` | `../web/src/adapters/firewallHost/api.ts`(264 行)+ `api.test.ts`(587 行) | Hono 重写 | 按第六节工厂模式;parse 函数原样搬入;测试改 `app.request(new Request(...))` 驱动、fake service 注入,状态码+中文文案+响应形状断言逐条保留;防火墙根路径以**无尾斜杠**形为用例(D1) |
| 16 | `apps/server/src/ssh/sshService.ts` + `.test.ts` | `../web/src/adapters/sshHost/sshService.ts` + `.test.ts` | git mv 改导入 | 改 errors/noteValidation/authorizedKeys/contracts 四条 import |
| 17 | `apps/server/src/ssh/{parseSshdConfig,patchSshdConfig,parseSshLog}.ts` 及 `.test.ts` | 同名文件 | git mv 改导入 | 与 #16 并行 |
| 18 | `apps/server/src/ssh/sshHostDeps.ts` + `.test.ts` | `../web/src/adapters/sshHost/api.node.ts` + `api.node.test.ts`(186 行) | git mv 改导入 | resolveSshAvailability 改 re-export 共享函数(断言不变);pid 核实、chpasswd stdin、密钥工作目录预建原样;**throwingDeps 硬边界用例必须随迁保住 503 不漏执行**;测试文件改名 |
| 19 | `apps/server/src/ssh/sshRoutes.ts` + `.test.ts` | `../web/src/adapters/sshHost/api.ts`(165 行)+ `api.test.ts`(408 行) | Hono 重写 | body 内联校验(enabled 布尔、auth-methods 双布尔、port 有限数、policy 契约枚举、password 非空串、keys name/userId)原样搬入;POST /root-key 无输入仍走 readJsonBody 保持守卫一致(原 api.ts:118-123 注释语义) |
| 20 | `apps/server/src/users/usersService.ts` + `.test.ts` | `../web/src/adapters/usersHost/usersService.ts` + `.test.ts` | git mv 改导入 | 同 #16 四条 import |
| 21 | `apps/server/src/users/parseSystemUsers.ts` + `.test.ts` | `../web/src/adapters/usersHost/parseSystemUsers.ts` + `.test.ts` | git mv 改导入 | 唯一改动:parseKeyLines 指向 shared/authorizedKeys;D9 两文件独立 |
| 22 | `apps/server/src/users/usersHostDeps.ts` + `.test.ts` | `../web/src/adapters/usersHost/api.node.ts` + `api.node.test.ts`(287 行) | git mv 改导入 | resolveUsersAvailability 改 re-export;getent 退出码 2 归一、chpasswd stdin 管道 error 监听防 EPIPE 打崩进程的语义原样;测试改名 |
| 23 | `apps/server/src/users/usersRoutes.ts` + `.test.ts` | `../web/src/adapters/usersHost/api.ts`(106 行)+ `api.test.ts`(300 行) | Hono 重写 | users 根路径(GET/POST)**以带尾斜杠形为主用例**、无尾斜杠形为补充用例(D1,原 api.ts:68/73 的 `path === '/' \|\| path === ''` 双判在 strict:false 父应用下双命中);parseUserInput 原样搬入 |
| 24 | `apps/server/src/platformMemory/platformMemoryRoutes.ts` + `.test.ts` | `../web/src/adapters/platformMemory/api.ts` + `api.test.ts` | Hono 重写 | D12;web 侧 http/platformMemoryAdapter 零改动消费同路径 |
| 25 | web 拆除与代理接入(见第八节清单) | `../web/vite.config.ts:4-9,12-20`、boundaries.test.ts、三片目录等 | 原地修改 + git rm | 依赖全部路由片就位(#1-#24)与根脚本先行 |
| 26 | 部署编排与根脚本 | 仓库根 `package.json`、`docker-compose.yml` | 原地修改 | D5/D8;compose command 不动;依赖 server 包先行 |

## 八、web 侧拆除清单(#25 的展开)

全部完成前 `bun run test` 与 `bun run typecheck`(web)不得转绿后又被后续步骤弄红。

1. `vite.config.ts`:删除四个被迁插件的 import 与挂载(`firewallApi.vite.ts`、`sshApi.vite.ts`、`usersApi.vite.ts`、`platformMemory.vite.ts`),保留 `elysianEventsVitePlugin`;`ALLOWED_HOSTNAMES` 导入改 `'../server/src/shared/allowedHostnames.ts'`(该常量文件删除前就先切,防挂空引用);`server.proxy` 增 `'/api/security'` 与 `'/api/platform'` → `http://127.0.0.1:48101`(不设 changeOrigin,D4);`preview.proxy` 同款(D8)。
2. `git rm -r ../web/src/adapters/firewallHost/`、`sshHost/`、`usersHost/` 三目录;`git rm` platformMemory 四文件(`api.ts`、`api.test.ts`、`api.node.ts`、`platformMemory.vite.ts`),保留 `types.ts` 与 `types.test.ts`(改 re-export,#2)。
3. `git rm -r ../web/src/adapters/endpointGuard/`(**guard.ts + guard.test.ts 全目录**;guard.ts:1 import node:http,残留而白名单已收缩则 boundaries.test 立即失败)。
4. `../web/src/app/boundaries.test.ts`:`NODE_SIDE_ALLOWLIST` 收缩为 6 条——`adapters/sse/mockEventsPlugin.ts`、`adapters/sse/mockEventsPlugin.node.ts`、`adapters/sse/mockEventsPlugin.vite.ts`、`adapters/hostMetrics/metricsStore.ts`、`adapters/hostMetrics/readHostSample.ts`、`adapters/hostMetrics/isDockerEnv.ts`。
5. 注释更新(指向已删路径的存量注释,含 `PANEL_PORT` 双处同值的现状说明):`adapters/http/sshHttpAdapter.test.ts:15`、`adapters/http/usersHttpAdapter.test.ts:12`、`features/security/FirewallRuleDialog.test.tsx:12`、`features/security/FirewallScanDialog.tsx:16`、`features/security/HostUserDialog.test.tsx:9`、`features/security/HostUserDialog.tsx:26`、`features/security/firewallRuleIO.ts:100`,统一改指 server 侧新路径(如 `server/src/shared/noteValidation`);`components/MemoryMonitorBadge.tsx` 的监控对象注释按 D7 改写。
6. web 三配置文件(`tsconfig.json`、`vite.build.config.ts`、`vitest.config.ts`)**不改**(理由见第二节);其注释措辞继续描述「不加载含 bun:sqlite 的 dev 中间件插件」,不得写成 web 已无 bun:sqlite。
7. 浏览器侧零改动红线:mock adapter、http adapter、Gateway 分流(mock/gateway.ts 的 isDockerRuntime 决定 http/mock)、SSE eventsAdapter 与内存降级路径一行不改;全部响应 JSON 形状逐端点保持(http adapter 逐字段校验,形状漂移即拒)。

## 九、部署编排与根脚本(#26 的展开)

仓库根 `package.json`:`dev` 与 `preview` 按 D5/D8 双进程;`test` 改为依次跑 `bun run --filter @elysian/web test && bun run --filter @elysian/server test`(contracts 无 test 脚本,不用 `--filter '*'`);`typecheck` 已是 `--filter '*'` 自动纳入 server;`build` 仍只 build web(server 由 Bun 直跑 TS 源,无需构建)。`docker-compose.yml` command 不动(D5);容器重建验证属联调阶段(`docker compose exec web` 内验证端点),本方案只改编排与脚本文件。

## 十、测试纪律

`guard.test.ts` 随迁并全绿(基线 19 用例,2026-09-22 以 `bun run vitest run --config vitest.config.ts src/adapters/endpointGuard/guard.test.ts` 在 web 侧实测通过)。服务与解析模块测试 git mv 随迁、只改 import 不改断言——**迁移期间服务测试断言不得随迁移改写**,行为漂移会伪装成测试适配;本次只允许改 import 路径与测试驱动方式(req/res 桩 → app.request)。路由测试由各 api.test.ts 改写为 Hono `app.request` 驱动、fake service 注入、不执行任何真实命令;守卫链各状态(503/403/415/413/400/404/405)与中文文案逐字断言;users 根以带尾斜杠形为主用例、防火墙根以无尾斜杠形为用例(D1)。server 的 test 脚本 = vitest run + bun test 显式点名 `src/firewall/ruleTimesStore.bun.test.ts`,vitest.config 排除 `*.bun.test.ts`(第二节)。web 删除已迁端点测试后 `bun run test` 全绿;boundaries.test 白名单收缩后仍守住浏览器侧零 node: 依赖。新写文件的路由测试对挂载后行为(strict:false 双形式、all('*') 404 兜底剥前缀)必须有用例锚定。

## 十一、迁移顺序(依赖链)

1. 契约上提 #1、#2(全部迁移的前置)。
2. shared 与 middleware:#3 errors → #4 allowedHostnames → #5 isDockerEnv → #6 availability → #8 noteValidation → #9 authorizedKeys → #7 guard(+test)。
3. 三片并行(firewall / ssh / users 各自:#服务 git mv → #解析组 → #接线 hostDeps → #路由 Hono 重写)。
4. platformMemory 路由 #24(依赖 #2)。
5. `app.ts` + `index.ts` 装配,server 侧 typecheck/test 全绿。
6. 根脚本 #26(dev/preview/test)。
7. web 拆除与代理接入 #25(依赖 #1-#26 全部就位);web typecheck/test 全绿。

每步收口跑对应包的 `typecheck` 与 `test`;宿主机是 macOS,只跑 bun 的 typecheck/test 与只读命令,绝不执行 ufw/iptables/useradd 等系统命令;容器内验证经 `docker compose exec web`。
