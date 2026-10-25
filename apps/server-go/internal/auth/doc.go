// Package auth 实现 /api/auth 登录鉴权片（auth 盘点 .zcode/go-migration/inventories/auth.md
// 的 Go 等价物）：单用户 admin 凭据（scrypt，格式串与 TS 版逐字兼容）、服务端会话与
// HttpOnly Cookie、登录限流、SSO returnTo 裁决、首启初始密码、`elysian resetpwd` 改密
// CLI 与 app 级 RequireSession 中间件。
//
// 导出形状（go-plan §3.8 冻结）：NewRouter（挂载 /api/auth）、RequireSession（app 级）、
// NewSessionConnections（seam.SessionConnections 实现，装配期一次、auth 与 terminals
// 共享实例）、FirstBootCredentials（main 启动序列）、RunResetPasswordCLI（子命令）与
// RunResetPasswordCLIAt（ely 菜单按注入 panelHome 对准凭据文件的同一改密线）。
//
// auth 域不执行任何宿主命令、不碰任何 unix socket、不访问 Docker/Caddy；全部 IO 收口
// 在 ~/.Elysian 下三个 JSON 文件（凭据、会话、回跳白名单）与一条改密安全审计 JSONL
// （logs/panel-password-audit.jsonl，HTTP 与 CLI 两条改密线追加，不含密码内容），三种
// 运行模式下行为一致。
package auth
