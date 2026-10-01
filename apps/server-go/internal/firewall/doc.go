// Package firewall 实现 /api/security/firewall 防火墙片（ufw/ss/iptables 直接执行、
// 规则时间账本 firewall.sqlite、启动 restoreIfNeeded）与 seam.PortOpener。
// 行为权威是 .zcode/go-migration/inventories/firewall.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 firewall 域实现者替换本占位。
package firewall
