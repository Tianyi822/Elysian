package client

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// 会话片消费（/api/agent/sessions）：列表按活动排序游标分页，写操作全部经同源
// 守卫下的 JSON 端点；重命名／删除的校验以服务端回执为权威，client 只做与服务端
// 同口径的本地预检（标题 TrimSpace 非空且 ≤200 字节）。

// sessionsPageSize 会话列表单页条数（Web 侧同值；limit 服务端上限 200）。
const sessionsPageSize = 50

// ListSessionsByActivity 按活动时间倒序拉取会话页；cursor 为空取首页。
func (c *Client) ListSessionsByActivity(ctx context.Context, cursor string) (Page[Session], error) {
	query := map[string]string{"sort": "activity", "limit": fmt.Sprintf("%d", sessionsPageSize)}
	if cursor != "" {
		query["cursor"] = cursor
	}
	var page Page[Session]
	_, err := c.do(ctx, "GET", "/api/agent/sessions", query, nil, &page, "")
	return page, err
}

// GetSession 读取单个会话；不存在时回 404 KindServer 错误（消息「会话不存在」）。
func (c *Client) GetSession(ctx context.Context, id string) (Session, error) {
	var session Session
	_, err := c.do(ctx, "GET", "/api/agent/sessions/"+url.PathEscape(id), nil, nil, &session, "会话不存在或已被删除")
	return session, err
}

// CreateSession 创建会话（标题可为空，服务端归一为「新会话」；模型须为支持文本与
// 工具调用的可用修订）。409 等拒绝以 *Error 带服务端中文原因返回。
func (c *Client) CreateSession(ctx context.Context, input CreateSessionInput) (Session, error) {
	var session Session
	_, err := c.do(ctx, "POST", "/api/agent/sessions", nil, input, &session, "")
	return session, err
}

// ValidateTitle 标题本地预检（与服务端同口径）：TrimSpace 非空且 ≤200 字节。
func ValidateTitle(title string) error {
	if len([]byte(title)) > MaxTitleBytes {
		return fmt.Errorf("会话标题不能超过 %d 字节", MaxTitleBytes)
	}
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("会话标题不能为空")
	}
	return nil
}

// RenameSession 重命名会话（服务端 TrimSpace 落库、不更新活动时间、运行中允许）。
func (c *Client) RenameSession(ctx context.Context, id, title string) (Session, error) {
	body := struct {
		Title string `json:"title"`
	}{Title: title}
	var session Session
	_, err := c.do(ctx, "PUT", "/api/agent/sessions/"+url.PathEscape(id)+"/title", nil, body, &session, "会话不存在或已被删除")
	return session, err
}

// DeleteSession 删除会话：409（忙碌或结果未确认）时错误消息为服务端中文原因，
// 调用方不得做本地清理。
func (c *Client) DeleteSession(ctx context.Context, id string) error {
	_, err := c.do(ctx, "DELETE", "/api/agent/sessions/"+url.PathEscape(id), nil, nil, nil, "会话不存在或已被删除")
	return err
}

// SwitchSessionModel 切换会话固定模型（仅空闲会话可切；同模型同修订无需重切）。
func (c *Client) SwitchSessionModel(ctx context.Context, id string, input SwitchModelInput) (Session, error) {
	var session Session
	_, err := c.do(ctx, "PUT", "/api/agent/sessions/"+url.PathEscape(id)+"/model", nil, input, &session, "会话不存在或已被删除")
	return session, err
}

// ListSessionTasks 拉取会话任务页（任务按创建序）；会话详情取最新 agent 任务的
// latestRun 作为运行状态展示材料。
func (c *Client) ListSessionTasks(ctx context.Context, sessionID string, limit int) (Page[Task], error) {
	query := map[string]string{"limit": fmt.Sprintf("%d", limit)}
	var page Page[Task]
	_, err := c.do(ctx, "GET", "/api/agent/sessions/"+url.PathEscape(sessionID)+"/tasks", query, nil, &page, "")
	return page, err
}

// GetRun 读取单个运行。
func (c *Client) GetRun(ctx context.Context, id string) (Run, error) {
	var run Run
	_, err := c.do(ctx, "GET", "/api/agent/runs/"+url.PathEscape(id), nil, nil, &run, "运行不存在")
	return run, err
}

// AgentRuntime 读取运行能力报告（不依赖 Agent 服务可用；available:false 携带
// reason，是 Agent 不可用态的权威判定端点）。
func (c *Client) AgentRuntime(ctx context.Context) (RuntimeInfo, error) {
	var info RuntimeInfo
	_, err := c.do(ctx, "GET", "/api/agent/runtime", nil, nil, &info, "")
	return info, err
}
