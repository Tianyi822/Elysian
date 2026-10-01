// Package firewall 实现 /api/security/firewall 防火墙片（ufw/ss/iptables 直接执行、
// 规则时间账本 firewall.sqlite、启动 restoreIfNeeded）与 seam.PortOpener。
// 行为权威是 .zcode/go-migration/inventories/firewall.md 盘点。
//
// 组成：
//   - contract.go：防火墙视图模型与常量（FirewallToggles/FirewallRule/...、PanelPort、
//     DefaultScanConfig）。总纲 §4.4 把这些列在 internal/contract 清单里，骨架尚未预置，
//     已登记 gaps；它们当前只被本域使用，先落在本包，不构成跨域共享类型。
//   - jscompat.go：JS encodeURIComponent / Number 语义兼容层（canonical id 与「宽进」
//     请求体解析依赖它，盘点 §9.1/§9.6）。
//   - parseufw.go / forwardrules.go / scanrules.go / pingrules.go / parsesockets.go：
//     ufw/iptables/ss 输出与规则文件标记段的纯解析（TS 版逐文件等价物）。
//   - hostfiles.go：落盘方式（普通文件原子写、/proc 与 /sys 内核接口直写）。
//   - ruletimes.go：firewall.sqlite 时间账本（modernc.org/sqlite，与 bun:sqlite 同文件兼容）。
//   - service.go：服务编排（保底规则、disable→enable 重载、转发内核同步、防扫描统计、
//     规则文件串行队列）。
//   - hostdeps.go：真实接线（exec ufw/ss/iptables/ip6tables、账本打开、启动恢复）。
//   - routes.go：/api/security/firewall 路由（503→403→读体→端点→404）与 NewPortOpener。
package firewall
