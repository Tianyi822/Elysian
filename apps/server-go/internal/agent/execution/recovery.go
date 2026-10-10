package execution

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"

	"elysian/server/internal/agent/execution/config"
)

// Recover 必须在首次接受任务前调用。仅回收带本执行器标签与有效身份的遗留对象。
// 停止无法确认时返回错误，宿主应停止派发直到下次成功恢复。
func (e *Executor) Recover(ctx context.Context) error {
	e.mu.Lock()
	busy := len(e.active) > 0 || e.closed
	e.mu.Unlock()
	if busy {
		return problem(409, "execution-recovery-busy", "执行器运行期间不能进行启动恢复")
	}
	filter, _ := json.Marshal(map[string][]string{"label": {"elysian.agent.execution=true"}})
	query := url.QueryEscape(string(filter))
	var containers []struct {
		ID     string `json:"Id"`
		Labels map[string]string
	}
	if err := e.call(ctx, "GET", "/containers/json?all=1&filters="+query, nil, &containers); err != nil {
		return err
	}
	if len(containers) > 128 {
		return problem(503, "execution-recovery-limit", "遗留执行容器数量超过自动恢复上限")
	}
	for _, c := range containers {
		identity := c.Labels["elysian.agent.execution.id"]
		if c.Labels["elysian.agent.execution"] != "true" || !identityPattern.MatchString(identity) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(c.ID) {
			return stopError()
		}
		if err := e.remove(ctx, c.ID, identity); err != nil {
			return err
		}
	}
	var volumes struct {
		Volumes []struct {
			Name   string
			Labels map[string]string
		}
	}
	if err := e.call(ctx, "GET", "/volumes?filters="+query, nil, &volumes); err != nil {
		return err
	}
	if len(volumes.Volumes) > 128 {
		return problem(503, "execution-recovery-limit", "遗留执行卷数量超过自动恢复上限")
	}
	for _, v := range volumes.Volumes {
		identity := v.Labels["elysian.agent.execution.id"]
		if v.Labels["elysian.agent.execution"] != "true" || !identityPattern.MatchString(identity) || !regexp.MustCompile(`^elysian-agent-[a-f0-9]{32}$`).MatchString(v.Name) {
			return stopError()
		}
		if err := e.removeVolume(ctx, v.Name, identity); err != nil {
			return err
		}
	}
	return nil
}

// RevokeGrant 关闭使用该授权的已存在容器和隧道；revision=0 覆盖全部历史修订。
func (e *Executor) RevokeGrant(ctx context.Context, id string, revision int) error {
	e.mu.Lock()
	e.recordRevocation("grant:"+id, revision)
	matches := []*Process{}
	for _, p := range e.active {
		if p.grant != nil && p.grant.ID == id && (revision == 0 || p.grant.Revision == revision) {
			matches = append(matches, p)
		}
	}
	e.mu.Unlock()
	var first error
	for _, p := range matches {
		if err := p.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (e *Executor) RevokeServer(ctx context.Context, id string, revision int) error {
	e.mu.Lock()
	e.recordRevocation("server:"+id, revision)
	matches := []*Process{}
	for _, p := range e.active {
		if p.serverID == id && (revision == 0 || p.serverRevision == revision) {
			matches = append(matches, p)
		}
	}
	e.mu.Unlock()
	var first error
	for _, p := range matches {
		if err := p.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}
func (e *Executor) recordRevocation(key string, revision int) {
	if e.revoked[key] == nil {
		e.revoked[key] = make(map[int]bool)
	}
	e.revoked[key][revision] = true
}
func (e *Executor) revokedSource(grant *config.Grant, server string, revision int) bool {
	if grant != nil {
		revisions := e.revoked["grant:"+grant.ID]
		if revisions[0] || revisions[grant.Revision] {
			return true
		}
	}
	revisions := e.revoked["server:"+server]
	return server != "" && (revisions[0] || revisions[revision])
}
