package client

import (
	"context"
	"net/url"
	"strconv"
)

// 面板维护 DTO 与既有 /api/panel 协议对齐；CLI 不导入 panel 业务域。
type PanelCLIRegistration struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type PanelTask struct {
	ID              string                `json:"id"`
	Kind            string                `json:"kind"`
	State           string                `json:"state"`
	Phase           string                `json:"phase"`
	CreatedAt       string                `json:"createdAt"`
	UpdatedAt       string                `json:"updatedAt"`
	TargetCommit    string                `json:"targetCommit"`
	UpdateSource    string                `json:"updateSource,omitempty"`
	UpdateChannel   string                `json:"updateChannel,omitempty"`
	ReleaseTag      string                `json:"releaseTag,omitempty"`
	Error           string                `json:"error"`
	WorkerDead      bool                  `json:"workerDead,omitempty"`
	WorkerStatus    string                `json:"workerStatus,omitempty"`
	CLIRegistration *PanelCLIRegistration `json:"cliRegistration,omitempty"`
}

func (t PanelTask) Active() bool { return t.State == "queued" || t.State == "running" }

type PanelInfo struct {
	ResourcePreflightVersion int        `json:"resourcePreflightVersion,omitempty"`
	Commit                   string     `json:"commit"`
	BuildTime                string     `json:"buildTime"`
	Available                bool       `json:"available"`
	Reason                   string     `json:"reason"`
	ActiveTask               *PanelTask `json:"activeTask"`
	LastTask                 *PanelTask `json:"lastTask"`
}

type PanelUpdate struct {
	Source        string `json:"source"`
	Channel       string `json:"channel"`
	ReleaseTag    string `json:"releaseTag"`
	Branch        string `json:"branch"`
	CurrentCommit string `json:"currentCommit"`
	TargetCommit  string `json:"targetCommit"`
	Message       string `json:"message"`
	Available     bool   `json:"available"`
}

type PanelUpdateInput struct {
	RequestID    string             `json:"requestId"`
	Source       string             `json:"source"`
	Channel      string             `json:"channel"`
	TargetCommit string             `json:"targetCommit"`
	ReleaseTag   string             `json:"releaseTag"`
	ResourcePlan *PanelResourcePlan `json:"resourcePlan,omitempty"`
}
type PanelResourcePlan struct {
	PreflightID string   `json:"preflightId"`
	Targets     []string `json:"targets"`
	StopPanel   bool     `json:"stopPanel"`
}
type PanelResourceCandidate struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	MemoryBytes    *uint64 `json:"memoryBytes"`
	Recommended    bool    `json:"recommended"`
	DisabledReason string  `json:"disabledReason,omitempty"`
}
type PanelUpdatePreflight struct {
	ID        string `json:"id"`
	ExpiresAt string `json:"expiresAt"`
	Memory    struct {
		TotalBytes     uint64 `json:"totalBytes"`
		AvailableBytes uint64 `json:"availableBytes"`
		RequiredBytes  uint64 `json:"requiredBytes"`
		SwapTotalBytes uint64 `json:"swapTotalBytes"`
		SwapFreeBytes  uint64 `json:"swapFreeBytes"`
	} `json:"memory"`
	Disk struct {
		AvailableBytes uint64 `json:"availableBytes"`
	} `json:"disk"`
	Load                 [3]float64               `json:"load"`
	ActiveAgentRuns      int                      `json:"activeAgentRuns"`
	Candidates           []PanelResourceCandidate `json:"candidates"`
	NeedsRelease         bool                     `json:"needsRelease"`
	StopPanelRecommended bool                     `json:"stopPanelRecommended"`
	BlockedReason        string                   `json:"blockedReason,omitempty"`
}

type PanelTaskReport struct {
	Task       PanelTask `json:"task"`
	Logs       string    `json:"logs"`
	NextOffset int64     `json:"nextOffset"`
	HasMore    bool      `json:"hasMore"`
}

type PanelCommit struct {
	SHA     string `json:"sha"`
	Message string `json:"message"`
	Time    string `json:"time"`
}

func (c *Client) PanelInfo(ctx context.Context) (out PanelInfo, err error) {
	_, err = c.do(ctx, "GET", "/api/panel/", nil, nil, &out, "面板维护接口不可用，请核对 CLI 与面板版本")
	return
}
func (c *Client) CheckPanelUpdate(ctx context.Context, source, channel string) (out PanelUpdate, err error) {
	_, err = c.do(ctx, "GET", "/api/panel/update", map[string]string{"source": source, "channel": channel}, nil, &out, "")
	return
}
func (c *Client) PanelCommits(ctx context.Context, source, channel string) (out []PanelCommit, err error) {
	_, err = c.do(ctx, "GET", "/api/panel/commits", map[string]string{"source": source, "channel": channel}, nil, &out, "")
	return
}
func (c *Client) SubmitPanelUpdate(ctx context.Context, input PanelUpdateInput) (out PanelTask, err error) {
	_, err = c.do(ctx, "POST", "/api/panel/update", nil, input, &out, "")
	return
}
func (c *Client) PreflightPanelUpdate(ctx context.Context, input PanelUpdateInput) (out PanelUpdatePreflight, err error) {
	target := struct {
		Source       string `json:"source"`
		Channel      string `json:"channel"`
		TargetCommit string `json:"targetCommit"`
		ReleaseTag   string `json:"releaseTag"`
	}{input.Source, input.Channel, input.TargetCommit, input.ReleaseTag}
	_, err = c.do(ctx, "POST", "/api/panel/update/preflight", nil, target, &out, "更新资源预检不可用，请核对 CLI 与面板版本")
	return
}
func (c *Client) PanelTaskByRequest(ctx context.Context, id string) (out *PanelTask, err error) {
	var task PanelTask
	_, err = c.do(ctx, "GET", "/api/panel/tasks/by-request/"+url.PathEscape(id), nil, nil, &task, "")
	if e, ok := err.(*Error); ok && e.Status == 404 {
		return nil, nil
	}
	if err == nil {
		out = &task
	}
	return
}
func (c *Client) PanelTaskReport(ctx context.Context, id string, offset int64) (out PanelTaskReport, err error) {
	_, err = c.do(ctx, "GET", "/api/panel/tasks/"+url.PathEscape(id), map[string]string{"offset": strconv.FormatInt(offset, 10)}, nil, &out, "维护任务不存在或记录损坏")
	return
}
func (c *Client) RetryPanelCLI(ctx context.Context, id string) (out PanelTask, err error) {
	_, err = c.do(ctx, "POST", "/api/panel/tasks/"+url.PathEscape(id)+"/cli-registration/retry", nil, struct{}{}, &out, "")
	return
}
func (c *Client) PanelHealth(ctx context.Context) (commit string, err error) {
	var out struct {
		OK     bool   `json:"ok"`
		Commit string `json:"commit"`
	}
	_, err = c.do(ctx, "GET", "/api/health", nil, nil, &out, "")
	if err == nil && !out.OK {
		err = errClient(KindBadResponse, "面板健康检查未通过")
	}
	return out.Commit, err
}
