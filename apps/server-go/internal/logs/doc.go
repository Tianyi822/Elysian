// Package logs 实现 /api/logs 平台日志片（运行/操作/登录三类报告）与 app 级操作审计
// 中间件（影子路由表预匹配、summarize 摘要、登录日志与 5xx 运行日志规则）。
// 行为权威是 .zcode/go-migration/inventories/logs.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 logs 域实现者替换本占位。
package logs
