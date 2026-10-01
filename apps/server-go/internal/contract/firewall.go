package contract

// FirewallPortSync 端口放行同步结果（TS FirewallPortSync 的 Go 版）：
// opened=本次新写入并已复核；skipped=已有等价放行规则或防火墙片不可用，无需动作；
// failed=写入未生效，需要用户到安全页处理。Detail 在 skipped/failed 时为中文说明，
// opened 为 null（指针 nil）。
type FirewallPortSync struct {
	State  string  `json:"state"`
	Port   int     `json:"port"`
	Detail *string `json:"detail"`
}

// FirewallPortSyncState 取值。
const (
	FirewallPortSyncOpened  = "opened"
	FirewallPortSyncSkipped = "skipped"
	FirewallPortSyncFailed  = "failed"
)

// FirewallPortSyncDetailSkipped 是防火墙片不可用时的固定 skipped 说明（装配层注入
// NoopPortOpener 时恒用它，逐字契约）。
const FirewallPortSyncDetailSkipped = "防火墙片不可用，端口未自动开放"
