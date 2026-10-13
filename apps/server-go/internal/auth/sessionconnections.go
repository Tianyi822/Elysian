package auth

import (
	"sync"

	"elysian/server/internal/seam"
)

// 会话连接撤销表（sessionConnections.ts 等价物，seam.SessionConnections 的实现）：
// sessionId → 该会话名下已建立长连接的 closer 集合。新登录替换、登出、改密（pwdEpoch
// 轮换）、退出其他会话在销毁服务端会话的同时，主动关闭该会话名下已建立的
// 终端 WS 与聊天 SSE 连接。纯内存结构，装配期创建一次，auth 流鉴权与 terminals
// 登记 closer，auth 路由触发撤销；注销句柄只指向本次登记。
//
// 关闭口径常量（seam 包冻结）：seam.SessionRevokedCloseCode = 1008、
// seam.SessionRevokedCloseReason = "面板会话已失效，连接已关闭"；closer 关闭连接时使用。

type closerEntry struct {
	fn func()
}

type sessionConnections struct {
	mu        sync.Mutex
	bySession map[string][]*closerEntry
}

// NewSessionConnections 构造会话连接撤销表（装配期一次）。
func NewSessionConnections() seam.SessionConnections {
	return &sessionConnections{bySession: map[string][]*closerEntry{}}
}

// Register 以独立条目标识连接，闭包来自同一函数也不会在注销时误删其他连接。
func (c *sessionConnections) Register(sessionID string, closer func()) func() {
	if closer == nil {
		return func() {}
	}
	entry := &closerEntry{fn: closer}
	c.mu.Lock()
	c.bySession[sessionID] = append(c.bySession[sessionID], entry)
	c.mu.Unlock()
	return sync.OnceFunc(func() { c.unregister(sessionID, entry) })
}

func (c *sessionConnections) unregister(sessionID string, target *closerEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries := c.bySession[sessionID]
	for i, entry := range entries {
		if entry == target {
			c.bySession[sessionID] = append(entries[:i:i], entries[i+1:]...)
			break
		}
	}
	if len(c.bySession[sessionID]) == 0 {
		delete(c.bySession, sessionID)
	}
}

// Revoke 实现 seam.SessionConnections：关闭该会话全部 closer 并清空，可重入。
func (c *sessionConnections) Revoke(sessionID string) {
	c.mu.Lock()
	entries := c.bySession[sessionID]
	delete(c.bySession, sessionID)
	c.mu.Unlock()
	closeAll(entries)
}

// RevokeOthers 实现 seam.SessionConnections：关闭除 keep 外的全部会话。
func (c *sessionConnections) RevokeOthers(keepSessionID string) {
	var groups [][]*closerEntry
	c.mu.Lock()
	for sessionID, entries := range c.bySession {
		if sessionID == keepSessionID {
			continue
		}
		groups = append(groups, entries)
		delete(c.bySession, sessionID)
	}
	c.mu.Unlock()
	for _, entries := range groups {
		closeAll(entries)
	}
}

// RevokeAll 实现 seam.SessionConnections：关闭全部会话的全部 closer，可重入。
func (c *sessionConnections) RevokeAll() {
	c.mu.Lock()
	groups := make([][]*closerEntry, 0, len(c.bySession))
	for _, entries := range c.bySession {
		groups = append(groups, entries)
	}
	c.bySession = map[string][]*closerEntry{}
	c.mu.Unlock()
	for _, entries := range groups {
		closeAll(entries)
	}
}

// closeAll 逐个调 closer：单个 panic 吞掉，不中断其余关闭（一个连接死透了不该拖累别的）。
func closeAll(entries []*closerEntry) {
	for _, entry := range entries {
		func() {
			defer func() { _ = recover() }()
			entry.fn()
		}()
	}
}
