package websites

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type AgentFacade struct {
	service   *websiteService
	authorize func(context.Context) error
}

// NewAgentFacade owns the same service and task manager used by the HTTP routes.
func NewAgentFacade(deps Deps) *AgentFacade {
	if !deps.EngineAvailable || deps.Engine == nil || deps.Views == nil {
		return nil
	}
	service, _ := newProductionService(deps).(*websiteService)
	return &AgentFacade{service: service, authorize: deps.AgentAuthorize}
}

func (a *AgentFacade) Registry() Registry     { return a.service.deps.registry }
func (a *AgentFacade) Caddy() seam.CaddyAdmin { return a.service.deps.caddy }
func (a *AgentFacade) Authorize(ctx context.Context) error {
	if a == nil || a.service == nil || a.authorize == nil {
		return errors.New("网站 Agent 服务或派发授权不可用")
	}
	return a.authorize(ctx)
}

type AgentRequest struct {
	ID         string           `json:"id,omitempty"`
	SourceID   string           `json:"sourceId,omitempty"`
	TaskID     string           `json:"taskId,omitempty"`
	Offset     int64            `json:"offset,omitempty"`
	Cursor     string           `json:"cursor,omitempty"`
	Limit      int              `json:"limit,omitempty"`
	RequestID  string           `json:"requestId,omitempty"`
	ReleaseID  string           `json:"releaseId,omitempty"`
	Mode       string           `json:"mode,omitempty"`
	Domain     string           `json:"domain,omitempty"`
	Deployment *deploymentInput `json:"deployment,omitempty"`
}

// Call accepts only typed domain operations and returns redacted projections.
func (a *AgentFacade) Call(ctx context.Context, action string, raw json.RawMessage) (any, error) {
	if err := a.Authorize(ctx); err != nil {
		return nil, err
	}
	var input AgentRequest
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, shared.InvalidRequest("网站工具参数无效")
	}
	m := a.service.deployments
	switch action {
	case "runtimes":
		return a.service.RuntimeCatalog(ctx)
	case "access":
		access, err := validateWebsiteAccessRequest(map[string]any{"mode": input.Mode, "domain": input.Domain})
		if err != nil {
			return nil, err
		}
		result, err := a.service.SetAccess(ctx, input.ID, access)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": input.ID, "accessMode": access.Mode, "domain": access.Domain, "firewallPort": result.FirewallPort}, nil
	case "rollback":
		if m == nil {
			break
		}
		task, err := m.rollbackRequest(ctx, input.ID, input.RequestID, input.ReleaseID)
		if err != nil {
			return nil, err
		}
		return agentTask(task), nil
	case "logs":
		project, err := a.service.record(ctx, input.ID)
		if err != nil {
			return nil, err
		}
		lines, err := a.service.Logs(ctx, input.ID)
		if err != nil {
			return nil, err
		}
		counts := map[string]int{"error": 0, "warning": 0, "other": 0}
		for _, line := range lines {
			lower := strings.ToLower(line)
			severity := "other"
			if strings.Contains(lower, "error") || strings.Contains(lower, "fatal") {
				severity = "error"
			} else if strings.Contains(lower, "warn") {
				severity = "warning"
			}
			counts[severity]++
		}
		entries := []any{map[string]any{"timestamp": time.Now().UTC().Format(time.RFC3339), "stream": "combined", "count": len(lines), "severityCounts": counts}}
		page, err := shared.AgentLogPage(entries, input.Cursor, input.Limit)
		if err != nil {
			return nil, err
		}
		page["id"], page["rawWithheld"], page["currentRelease"], page["previousRelease"] = project.ID, true, agentReleaseID(project.CurrentRelease), agentReleaseID(project.PreviousRelease)
		return page, nil
	case "start", "stop":
		project, err := a.service.SetRunning(ctx, input.ID, action == "start")
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": project.ID, "runState": project.RunState}, nil
	case "remove":
		if err := a.service.Remove(ctx, input.ID); err != nil {
			return nil, err
		}
		return map[string]bool{"removed": true}, nil
	case "source":
		if m == nil {
			break
		}
		source, err := m.getSource(input.SourceID)
		if err != nil {
			return nil, err
		}
		source.GitURL, source.FetchContainer, source.FetchImage = "", "", ""
		if source.Error != "" {
			source.Error = "来源准备未成功，请在网站页查看详情"
		}
		return source, nil
	case "deploy":
		if m == nil || input.Deployment == nil {
			break
		}
		// Secrets are entered by the human through the existing secure UI only.
		if input.Deployment.Access.PrivateKeyPEM != nil || input.Deployment.Access.CertificatePEM != nil {
			return nil, shared.InvalidRequest("Agent 部署不得接收证书或私钥原文，请复用已有项目")
		}
		target := input.Deployment.ProjectID
		if target == "" {
			target = input.Deployment.Name
			if input.Deployment.Access.Mode != AccessModeDirect {
				return nil, shared.InvalidRequest("新网站仅允许直接访问；域名证书请先由管理员在网站页配置")
			}
		}
		if input.ID != target {
			return nil, shared.InvalidRequest("网站目标与部署项目不一致")
		}
		task, err := m.submit(ctx, *input.Deployment)
		if err != nil {
			return nil, err
		}
		return agentTask(task), nil
	case "tasks":
		if m == nil {
			break
		}
		m.mu.Lock()
		rows := make([]deploymentTask, 0, len(m.tasks))
		for _, task := range m.tasks {
			if input.ID != "" && agentTaskTarget(*task) == input.ID {
				rows = append(rows, *task)
			}
		}
		m.mu.Unlock()
		sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt > rows[j].CreatedAt })
		if len(rows) > 100 {
			rows = rows[:100]
		}
		out := make([]any, 0, len(rows))
		for _, task := range rows {
			out = append(out, agentTask(task))
		}
		return out, nil
	case "task", "cancel", "task_logs":
		if m == nil {
			break
		}
		task, err := m.getTask(input.TaskID)
		if err != nil {
			return nil, err
		}
		if input.ID == "" || agentTaskTarget(task) != input.ID {
			return nil, shared.InvalidRequest("任务不属于该网站项目")
		}
		if action == "task" {
			return agentTask(task), nil
		}
		if action == "task_logs" {
			page, err := shared.AgentLogPage([]any{map[string]any{"timestamp": task.CreatedAt, "stream": "status", "state": "queued"}, map[string]any{"timestamp": task.UpdatedAt, "stream": "status", "state": task.State, "testResult": task.TestResult}}, input.Cursor, input.Limit)
			if err != nil {
				return nil, err
			}
			page["id"], page["rawWithheld"], page["reason"] = task.ID, true, "构建自由日志可能包含源码秘密；仅返回持久化结构化状态"
			return page, nil
		}
		m.mu.Lock()
		cancel := m.cancel[task.ID]
		m.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if task.State == "awaiting-config" {
			_ = m.mutate(task.ID, func(t *deploymentTask) { t.State = "cancelled"; t.Stage = "已取消" })
		}
		return map[string]any{"id": task.ID, "requestId": task.Input.RequestID, "cancelRequested": true}, nil
	}
	return nil, shared.InvalidRequest("网站 Agent 能力不可用")
}

func agentReleaseID(release *releaseRecord) string {
	if release == nil {
		return ""
	}
	return release.ID
}

func agentTask(task deploymentTask) any {
	return map[string]any{"id": task.ID, "requestId": task.Input.RequestID, "projectId": task.ProjectID, "target": agentTaskTarget(task), "sourceId": task.SourceID, "state": task.State, "stage": task.Stage, "createdAt": task.CreatedAt, "updatedAt": task.UpdatedAt, "testResult": task.TestResult}
}

func agentTaskTarget(task deploymentTask) string {
	if task.Input.ProjectID != "" {
		return task.Input.ProjectID
	}
	return task.Name
}

type AgentTaskStatus struct {
	State, RequestID string
	Terminal, Failed bool
	Value            any
	Error            string
}

func (a *AgentFacade) InspectTask(ctx context.Context, id string) (AgentTaskStatus, error) {
	if err := ctx.Err(); err != nil {
		return AgentTaskStatus{}, err
	}
	if a == nil || a.service == nil || a.service.deployments == nil {
		return AgentTaskStatus{}, errors.New("网站任务服务不可用")
	}
	task, err := a.service.deployments.getTask(id)
	if err != nil {
		return AgentTaskStatus{}, err
	}
	terminal := !unsettledDeployment(task) && (task.State == "succeeded" || task.State == "failed" || task.State == "cancelled" || task.State == "interrupted")
	message := ""
	if terminal && task.State != "succeeded" {
		message = "网站任务未成功完成，请在网站页查看详情"
	}
	return AgentTaskStatus{State: task.State, RequestID: task.Input.RequestID, Terminal: terminal, Failed: terminal && task.State != "succeeded", Value: agentTask(task), Error: message}, nil
}

func (a *AgentFacade) LookupTask(ctx context.Context, requestID string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if a == nil || a.service == nil || a.service.deployments == nil {
		return "", errors.New("网站任务服务不可用")
	}
	m := a.service.deployments
	m.mu.Lock()
	defer m.mu.Unlock()
	id := ""
	for _, task := range m.tasks {
		if task.Input.RequestID == requestID {
			if id != "" {
				return "", errors.New("网站请求匹配多个任务")
			}
			id = task.ID
		}
	}
	if id == "" {
		return "", errors.New("网站请求尚未找到任务")
	}
	return id, nil
}
