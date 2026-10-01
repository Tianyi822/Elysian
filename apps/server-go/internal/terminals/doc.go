// Package terminals 实现 /api/terminals 终端片（/ws 升级 + /status）与通用终端会话机
// （seam.TerminalKit 实现方：帧校验、ready 扣发、合帧节流、单轮预算、保序队列、空闲
// 超时、撤销接线；本机 PTY 与 docker 容器 exec 终端复用同一套）。
// 行为权威是 .zcode/go-migration/inventories/terminals.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 terminals 域实现者替换本占位。
package terminals
