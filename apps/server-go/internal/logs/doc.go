// Package logs 实现 /api/logs 平台日志片（运行/操作/登录三类报告与清空）与 app 级
// 操作审计中间件（影子路由预匹配、summarize 摘要、登录日志与 5xx 运行日志规则）。
// 行为权威是 .zcode/go-migration/inventories/logs.md 盘点；错误消息逐字对齐。
//
// 本片没有容器边界：只读写 ~/.Elysian 下面板自有目录，三种运行时模式同一套实现；
// 库打不开时回落不可用 store（查询 500「日志数据库不可用」、写入只计 failedWrites）。
package logs
