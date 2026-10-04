// Package panel 管理 systemd 安装版自身；系统访问收口在 Host 接口，域包不互相导入。
package panel

import (
	"context"
	"elysian/server/internal/config"
	"time"
)

const Repository = "Tianyi822/Elysian"
const InstallRoot = "/opt/elysian"
const ServiceName = "elysian"

// 构建脚本经 -ldflags 注入，导出的源码无需 Git 工作树。
var Commit = "unknown"
var BuildTime = "unknown"

type Task struct {
	ID           string              `json:"id"`
	Kind         string              `json:"kind"`
	State        string              `json:"state"`
	Phase        string              `json:"phase"`
	CreatedAt    time.Time           `json:"createdAt"`
	UpdatedAt    time.Time           `json:"updatedAt"`
	OldPorts     config.PanelNetwork `json:"oldPorts"`
	NewPorts     config.PanelNetwork `json:"newPorts"`
	TargetCommit string              `json:"targetCommit"`
	Error        string              `json:"error"`
}

type taskRecord struct {
	Task
	RequestID        string   `json:"requestId"`
	Origin           string   `json:"origin"`
	Worker           string   `json:"worker"`
	PreviousBinary   string   `json:"previousBinary"`
	Candidate        string   `json:"candidate"`
	Snapshot         string   `json:"snapshot"`
	SnapshotReady    bool     `json:"snapshotReady"`
	Activated        bool     `json:"activated"`
	Committed        bool     `json:"committed"`
	FirewallBefore   []string `json:"firewallBefore"`
	FirewallCaptured bool     `json:"firewallCaptured"`
}

func Active(state string) bool { return state == "queued" || state == "running" }

type Update struct {
	Repository    string `json:"repository"`
	Branch        string `json:"branch"`
	CurrentCommit string `json:"currentCommit"`
	TargetCommit  string `json:"targetCommit"`
	Message       string `json:"message"`
	Available     bool   `json:"available"`
}

// CommitLog 是上游仓库的一条提交；面板的更新日志按默认分支列出一批这样的条目。
type CommitLog struct {
	SHA     string    `json:"sha"`
	Message string    `json:"message"`
	Time    time.Time `json:"time"`
}

type Source interface {
	Check(context.Context) (Update, error)
	History(context.Context, int) ([]CommitLog, error)
	Download(context.Context, string, string) error
}

type Host interface {
	Available() bool
	Preflight(context.Context, config.PanelNetwork, config.PanelNetwork) error
	Dispatch(context.Context, string, string) error
	WorkerActive(context.Context, string) bool
	Build(context.Context, string, string, string) (string, error)
	Stop(context.Context) error
	Start(context.Context) error
	Healthy(context.Context, config.PanelNetwork, string) error
	Rules(context.Context) ([]string, error)
	AddRule(context.Context, string) error
	DeleteRule(context.Context, string) error
	VerifyRules(context.Context, config.PanelNetwork) error
}
