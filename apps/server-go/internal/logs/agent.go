package logs

import (
	"context"
	"errors"
	"net/url"
	"strconv"

	"elysian/server/internal/seam"
)

// AgentFacade returns structured log facts. Free text is intentionally omitted:
// application logs may contain credentials that cannot be reliably redacted.
type AgentFacade struct {
	service   ServiceAPI
	authorize func(context.Context) error
}

func NewAgentFacade(service seam.Logs, authorize func(context.Context) error) *AgentFacade {
	reader, _ := service.(ServiceAPI)
	return &AgentFacade{service: reader, authorize: authorize}
}

func (f *AgentFacade) Available() bool { return f != nil && f.service != nil }

func (f *AgentFacade) Read(ctx context.Context, category string, limit int) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !f.Available() || f.authorize == nil {
		return nil, errors.New("日志读取能力未就绪")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, errors.New("日志条数须为 1–100")
	}
	values := url.Values{"limit": []string{strconv.Itoa(limit)}}
	entries := []map[string]any{}
	var total int64
	var truncated bool
	switch category {
	case "runtime":
		q, err := ParseRuntimeListQuery(values)
		if err != nil {
			return nil, err
		}
		r, err := f.service.RuntimeLog(q)
		if err != nil {
			return nil, errors.New("读取运行日志失败")
		}
		for _, row := range r.Entries {
			source, event := agentLogEvent(row.Source)
			entries = append(entries, map[string]any{"id": row.ID, "at": row.At, "level": row.Level, "source": source, "event": event})
		}
		total, truncated = r.Total, r.Truncated
	case "operation":
		q, err := ParseOperationListQuery(values)
		if err != nil {
			return nil, err
		}
		r, err := f.service.OperationLog(q)
		if err != nil {
			return nil, errors.New("读取操作日志失败")
		}
		for _, row := range r.Entries {
			entries = append(entries, map[string]any{"id": row.ID, "at": row.At, "category": row.Category, "action": agentLogAction(row.Action), "result": row.Result, "httpStatus": row.HTTPStatus})
		}
		total, truncated = r.Total, r.Truncated
	case "login":
		q, err := ParseLoginListQuery(values)
		if err != nil {
			return nil, err
		}
		r, err := f.service.LoginLog(q)
		if err != nil {
			return nil, errors.New("读取登录日志失败")
		}
		for _, row := range r.Entries {
			entries = append(entries, map[string]any{"id": row.ID, "time": row.Time, "status": row.Status, "ip": row.IP})
		}
		total, truncated = r.Total, r.Truncated
	default:
		return nil, errors.New("日志类别未开放")
	}
	return map[string]any{"category": category, "entries": entries, "total": total, "truncated": truncated, "textOmitted": true}, ctx.Err()
}

func agentLogEvent(source string) (string, string) {
	switch source {
	case httpLogSource:
		return httpLogSource, "request-failed"
	case operationLogSource:
		return operationLogSource, "panel-operation"
	case "server.lifecycle":
		return "server.lifecycle", "service-lifecycle"
	case "logs.sweep":
		return "logs.sweep", "log-retention"
	default:
		return "other", "runtime-event"
	}
}

// Only server-declared action labels are suitable as model-visible text.
func agentLogAction(action string) string {
	for _, descriptor := range operationDescriptors {
		if descriptor.action == action {
			return descriptor.action
		}
	}
	return "操作"
}
