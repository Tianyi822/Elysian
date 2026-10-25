package client

import (
	"context"
	"strings"
)

// auth 片消费（/api/auth）：登录固定携带 client:"cli"（会话按客户端类别分道，
// 不替换浏览器会话，ADR-0022 修订语义）；启动判活用 ?passive=1（不续期），TUI
// 常驻期间的滑动续期由后续 /api/agent 业务请求自然完成。

// Login 以 CLI 类别登录：成功时从 Set-Cookie 提取 elysian_session 并保存到本
// 客户端；失败（401 凭据错误／429 限流）以 *Error 返回服务端中文消息。
func (c *Client) Login(ctx context.Context, username, password string) error {
	body := struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Client   string `json:"client"`
	}{Username: username, Password: password, Client: "cli"}
	var out struct {
		OK bool `json:"ok"`
	}
	header, err := c.do(ctx, "POST", "/api/auth/login", nil, body, &out, "")
	if err != nil {
		return err
	}
	if !out.OK {
		return &Error{Kind: KindBadResponse, Message: "登录响应异常：面板未确认成功"}
	}
	cookie, ok := sessionCookieFrom(header.Get("Set-Cookie"))
	if !ok {
		return &Error{Kind: KindBadResponse, Message: "登录响应缺少会话 Cookie"}
	}
	c.cookie = cookie
	return nil
}

// sessionCookieFrom 从 Set-Cookie 头解析 elysian_session 值；头不存在或不含该
// 键（如登出清 Cookie 形态）时返回 false。
func sessionCookieFrom(setCookie string) (string, bool) {
	for _, part := range strings.Split(setCookie, ";") {
		part = strings.TrimSpace(part)
		if value, found := strings.CutPrefix(part, "elysian_session="); found {
			return value, value != ""
		}
	}
	return "", false
}

// ProbeSession 以被动模式判活（GET /api/auth/session?passive=1，不续期空闲期）；
// 返回是否已登录。网络与五态错误原样上抛，由调用方决定是否回落登录流程。
func (c *Client) ProbeSession(ctx context.Context) (bool, error) {
	var out struct {
		Authenticated bool `json:"authenticated"`
		DevAccount    bool `json:"devAccount"`
	}
	_, err := c.do(ctx, "GET", "/api/auth/session", map[string]string{"passive": "1"}, nil, &out, "")
	if err != nil {
		return false, err
	}
	return out.Authenticated, nil
}

// Logout 销毁当前会话并清空本地 Cookie 状态；幂等（服务端无会话同样 200）。
func (c *Client) Logout(ctx context.Context) error {
	var out struct {
		OK bool `json:"ok"`
	}
	if _, err := c.do(ctx, "POST", "/api/auth/logout", nil, struct{}{}, &out, ""); err != nil {
		return err
	}
	c.cookie = ""
	return nil
}
