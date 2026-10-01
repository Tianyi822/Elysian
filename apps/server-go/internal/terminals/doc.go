// Package terminals 实现 /api/terminals 终端片（/ws 升级 + /status）与通用终端会话机
// （seam.TerminalKit 实现方：客户端帧校验、ready 扣发、合帧节流、单轮预算、保序队
// 列、空闲超时、撤销接线；本机 PTY 与 docker 容器 exec 终端复用同一套）。
// 行为权威是 .zcode/go-migration/inventories/terminals.md 盘点（错误文案、关闭码表、
// 帧形状与时序逐字对齐 TS 版 apps/server/src/terminals/）。
package terminals
