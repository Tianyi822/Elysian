// Package security 实现 /api/security/ssh 与 /api/security/users 两片（合一包）：
// sshd 配置读写、root 登录策略、登录密钥与登录记录、宿主账号管理，以及 files 域
// 消费的 seam.SystemAccounts（getent 通道）。行为权威是
// .zcode/go-migration/inventories/security.md 盘点；端点、错误文案（中文，逐字）、
// 副作用时序与三种运行时模式的分支全部照抄 TS 版（apps/server/src/ssh 与
// apps/server/src/users）。
//
// 可用性硬边界经装配注入（go-plan §5）：LocalDemo 两片整片 503（各自文案，含未知
// 路径，零宿主交互）；Docker 与 BareMetal 直接执行真实命令。域包不读 env、不读
// /.dockerenv。
package security
