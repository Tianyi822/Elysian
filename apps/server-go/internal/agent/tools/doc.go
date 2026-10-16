// Package tools 把 Elysian 现有的域能力封装成 kardia（Cordis 的 Go 移植）可以
// 管理的插件与工具，是 Agent 侧调用运维能力的唯一入口。
//
// 本包是库层：不接入 internal/app、不注册 HTTP 路由、不改动 kardia 与任何域包。
// 宿主（未来的 harness 或装配层）负责构造域对象、装载插件、持有 fiber 并在退出
// 时销毁。
//
// 装载形态：
//
//	root := kardia.NewContext()
//	fibers, err := tools.Install(ctx, root, tools.Plugin, docker.Plugin(deps, cfg))
//	registry, err := tools.RegistryFrom(root)
//	value, err := registry.Execute(root, "docker_containers_list", nil)
//
// 对需要统一持有 root 与生命周期的宿主接缝，也可直接使用 Runtime：
//
//	runtime, err := tools.NewRuntime(ctx, docker.Plugin(deps, cfg))
//	value, err := runtime.Execute(ctx, "docker_containers_list", nil)
//	defer runtime.Close(context.Background())
//
// Install 按依赖顺序装载并检查 FiberActive，失败逆序回滚。直接 Register 的条目
// 归注册表所有，RegisterAll 的条目归能力插件所有；撤销或卸载后，保留的处理器
// 引用也不可继续执行。已经进入域对象的请求依靠调用方 Lifetime 协作取消。
// 参数与模式以独立快照传递；JSON Schema 显式导出 additionalProperties=false。
// Caddy 工具只返回配置摘要，构建任务通过可注入的最小 BuildTasks 接口调用。
// Runtime 只管理进入 tools.Registry 的插件；任务工作区与 Bash 需要审批、
// 工作区版本和受限执行容器，因此由 harness 固定快照后调用 execution.Executor，
// 不把宿主路径或 Docker socket 注入工具处理器。
//
// 三条约定贯穿全部能力子包：
//
//  1. 服务方法的首参恒为调用点 Context（use site）。经 Registry.Execute 调用时，
//     登记包装器以能力提供者作为影子定义点，并保留调用方生命周期。
//  2. 域对象一律由宿主经各子包的 Deps 注入；本层不构造任何自带常驻 goroutine、
//     打开 sqlite 句柄或 fork 子进程的对象。这些域没有导出 Close（docker 的事件
//     hub、websites 的部署管理器、containerapps 的构建管理器、logs 的库句柄、
//     firewall 的启动期 UFW 恢复都属此类），本层若代为构造就无法兑现 kardia 的
//     Disposable 契约，只会把泄漏藏进 fiber。所有权归宿主，本层只持有、只调用。
//  3. 风险与审批不在本层裁决：描述符不带风险等级，本层只透传 tools/pre-execute
//     的拒绝，参数不合法、服务未提供、依赖缺项一律失败闭合。
//
// 每个能力子包（docker、logs、terminals、firewall、accounts、websites、
// containerapps、auth、panel）导出同一套形状：Deps（宿主注入的域对象）、New、
// Plugin、From 与 ServiceName；有自身开关的能力另有 Config（terminals、accounts
// 与 auth 没有）。每个子包至多 import 自己那一个域包，跨域接口一律取 internal/seam，
// 依赖面由 imports_test.go 用 go list -deps 自查。
//
// 本轮未覆盖的域：files（服务未导出）、platform（只有 NewRouter）、database
// （构造器与请求类型未导出且 fork 特权子进程）。firewall 的 21 方法 Service、
// websites 的主服务、security 的 ssh/users API 与 panel.Submit 尚未开放。logs
// 的读侧查询需经域的 Parse*ListQuery 取得私有查询类型，本层只包装写入接缝；
// containerapps 的两个构建预览需要 Engine 与完整构建请求，一并推迟。见 ADR-0023。
package tools
