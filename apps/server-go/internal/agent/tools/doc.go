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
// 三条约定贯穿全部能力子包：
//
//  1. 服务方法的首参恒为调用点 Context（use site），内部经 kardia.Service.CtxFor
//     取得影子链，与 kardia 自身的 timer 服务同形。
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
// Plugin、From 与 ServiceName；有自身开关的能力另有 Config（terminals 与 accounts
// 没有）。每个子包至多 import 自己那一个域包，跨域接口一律取 internal/seam，
// 依赖面由 imports_test.go 用 go list -deps 自查。
//
// 本轮未覆盖的域：files（服务未导出）、platform（只有 NewRouter）、database
// （构造器与请求类型未导出且 fork 特权子进程）。firewall 的 21 方法 Service、
// websites 的主服务、security 的 ssh/users API、panel.Submit、logs 的读侧查询
// 同样因域侧未导出而包不到；containerapps 的两个构建预览需要 Engine 与完整构建
// 请求，一并推迟。逐条登记在 ADR-0023。
package tools
