package security

import "elysian/server/internal/contract"

// security 域的 HTTP 响应视图模型（@elysian/contracts 的 security/ssh.ts 与 users.ts
// 等价物）。字段声明序即 JSON 键序（shared.MarshalJSON 的约定），privateKey 仅在
// 创建/生成响应里一次性携带（指针 nil 时省略），列表与查看永不返回。
//
// go-plan §4.4 把这些类型列在 internal/contract；骨架未预置，本域先行落在包内
// （仅本域消费，不构成跨域共享类型），已登记 gaps 由集成阶段归位。

// SshLoginCounts 一次登录统计：成功与失败各计一次。
type SshLoginCounts struct {
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// SshLoginStats 登录统计的三个窗口：今日、昨日、近 7 天。
type SshLoginStats struct {
	Today     SshLoginCounts `json:"today"`
	Yesterday SshLoginCounts `json:"yesterday"`
	Last7Days SshLoginCounts `json:"last7Days"`
}

// SshOverview 服务概况：开关、状态、上次启停时间与登录统计。
type SshOverview struct {
	Enabled     bool          `json:"enabled"`
	Status      string        `json:"status"`
	ChangedAt   *string       `json:"changedAt"`
	Stats       SshLoginStats `json:"stats"`
	RuntimeMode string        `json:"runtimeMode,omitempty"`
	LogInfo     *SshLogInfo   `json:"logInfo,omitempty"`
}

// SshLogInfo 统计来源及可用性；不可用时数字不应作为真实零值展示。
type SshLogInfo struct {
	Source    string  `json:"source"`
	Status    string  `json:"status"`
	SampledAt string  `json:"sampledAt"`
	Warning   *string `json:"warning"`
}

// SshAuthSettings 登录方式开关与监听端口。
type SshAuthSettings struct {
	PasswordAuthEnabled bool                       `json:"passwordAuthEnabled"`
	KeyAuthEnabled      bool                       `json:"keyAuthEnabled"`
	Port                int                        `json:"port"`
	FirewallPort        *contract.FirewallPortSync `json:"firewallPort,omitempty"`
}

// SshRootKey Root 密钥材料；PrivateKey 仅随创建/生成响应一次性携带。
type SshRootKey struct {
	Algorithm   string  `json:"algorithm"`
	Fingerprint string  `json:"fingerprint"`
	CreatedAt   string  `json:"createdAt"`
	PublicKey   string  `json:"publicKey"`
	PrivateKey  *string `json:"privateKey,omitempty"`
}

// SshRootAuth Root 登录策略与 Root 凭据。
type SshRootAuth struct {
	Policy          string      `json:"policy"`
	Key             *SshRootKey `json:"key"`
	PasswordResetAt *string     `json:"passwordResetAt"`
}

// SshPasswordResetResult 重置 Root 密码的结果：重置后的凭据快照与本次判定的强度。
type SshPasswordResetResult struct {
	Auth     SshRootAuth `json:"auth"`
	Strength string      `json:"strength"`
}

// SshLoginKey 登录密钥；PrivateKey 仅随创建响应一次性携带。
type SshLoginKey struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	UserID      string  `json:"userId"`
	Algorithm   string  `json:"algorithm"`
	Fingerprint string  `json:"fingerprint"`
	CreatedAt   string  `json:"createdAt"`
	PublicKey   string  `json:"publicKey"`
	PrivateKey  *string `json:"privateKey,omitempty"`
}

// SshLoginRecord 一条 SSH 登录记录。
type SshLoginRecord struct {
	ID     string `json:"id"`
	IP     string `json:"ip"`
	Port   int    `json:"port"`
	At     string `json:"at"`
	User   string `json:"user"`
	Result string `json:"result"`
}

// SshKeyAccount 密钥可归属的主机账号（轻量清单）。
type SshKeyAccount struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// sshListKeysReport 登录密钥列表附带脏行计数（GET /keys 响应形状）。
type sshListKeysReport struct {
	Keys                []SshLoginKey `json:"keys"`
	IgnoredInvalidLines int           `json:"ignoredInvalidLines"`
}

// HostUser 主机账号视图模型；CreatedAt 恒为 null（/etc/passwd 不记录）。
type HostUser struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	IsAdmin     bool    `json:"isAdmin"`
	LoginMethod string  `json:"loginMethod"`
	Status      string  `json:"status"`
	Note        *string `json:"note"`
	CreatedAt   *string `json:"createdAt"`
}
