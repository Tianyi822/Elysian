// Package security 实现 /api/security/ssh 与 /api/security/users 两片（合一包）：
// sshd 配置读写、root 登录策略、登录密钥与登录记录、宿主账号管理，以及 files 域
// 消费的 seam.SystemAccounts（getent 通道）。行为权威是
// .zcode/go-migration/inventories/security.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 security 域实现者替换本占位。
package security
