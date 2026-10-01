// Package auth 实现 /api/auth 登录鉴权片：单用户 admin 凭据（scrypt）、服务端会话与
// HttpOnly Cookie、首启初始密码、`elysian resetpwd` 改密 CLI 与 app 级 RequireSession
// 中间件。行为权威是 .zcode/go-migration/inventories/auth.md 盘点。
//
// 骨架阶段本包只声明存在；路由、服务与测试由 auth 域实现者替换本占位。
package auth
