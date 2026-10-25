package client

import (
	"context"
	"net/url"
)

// ListRuns 同时用于精确请求确认和会话执行历史；游标始终原样透传。
func (c *Client) ListRuns(ctx context.Context, sessionID, requestID, cursor string) (Page[Run], error) {
	var page Page[Run]
	_, err := c.do(ctx, "GET", "/api/agent/runs", map[string]string{"sessionId": sessionID, "requestId": requestID, "cursor": cursor, "limit": "50"}, nil, &page, "")
	return page, err
}

type ModelRequest struct {
	ID        string `json:"id"`
	RunID     string `json:"runId"`
	Index     int    `json:"index"`
	Purpose   string `json:"purpose"`
	Status    string `json:"status"`
	Reasoning string `json:"reasoning,omitempty"`
	Content   string `json:"content,omitempty"`
	Response  *struct {
		Reasoning string `json:"reasoning,omitempty"`
		Content   string `json:"content,omitempty"`
	} `json:"response,omitempty"`
	Error *Failure `json:"error,omitempty"`
}

func (c *Client) ModelRequests(ctx context.Context, runID, cursor string) (Page[ModelRequest], error) {
	var page Page[ModelRequest]
	_, err := c.do(ctx, "GET", "/api/agent/runs/"+url.PathEscape(runID)+"/model-requests", map[string]string{"cursor": cursor, "limit": "5"}, nil, &page, "运行不存在")
	return page, err
}

func (c *Client) ListSessionTasksPage(ctx context.Context, sessionID, cursor string) (Page[Task], error) {
	var page Page[Task]
	_, err := c.do(ctx, "GET", "/api/agent/sessions/"+url.PathEscape(sessionID)+"/tasks", map[string]string{"cursor": cursor, "limit": "200"}, nil, &page, "")
	return page, err
}
