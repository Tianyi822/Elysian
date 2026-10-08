package auth

import (
	"reflect"
	"sync"

	"elysian/server/internal/seam"
)

// 会话连接撤销表（sessionConnections.ts 等价物，seam.SessionConnections 的实现）：
// sessionId → 该会话名下已建立长连接的 closer 集合。新登录替换、登出、改密（pwdEpoch
// 轮换）、退出其他会话在销毁服务端会话的同时，主动关闭该会话名下已建立的
// 终端 WS 连接——否则连接层存活到自然断开，撤销只对新请求生效。纯内存结构，装配期
// 创建一次、app 把同一实例穿给 auth 片（触发端点）与 terminals 片（登记 closer）。
//
// 关闭口径常量（seam 包冻结）：seam.SessionRevokedCloseCode = 1008、
// seam.SessionRevokedCloseReason = "面板会话已失效，连接已关闭"；closer 关闭连接时使用。

type closerEntry struct {
	key uintptr // closer 函数值的 code pointer（Unregister 按它匹配；见下方限制说明）
	fn  func()
}

type sessionConnections struct {
	mu        sync.Mutex
	bySession map[string][]*closerEntry
}

// NewSessionConnections 构造会话连接撤销表（装配期一次）。
func NewSessionConnections() seam.SessionConnections {
	return &sessionConnections{bySession: map[string][]*closerEntry{}}
}

// Register 实现 seam.SessionConnections。Go 侧限制：closer 是不可比较的函数值，
// 无法像 TS Set 那样按引用去重——同一 closer 重复注册会在撤销时被调用两次；消费方
// （terminals 片）每条连接恰好 register 一次、close 时 unregister，语义不受影响。
func (c *sessionConnections) Register(sessionID string, closer func()) {
	if closer == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bySession[sessionID] = append(c.bySession[sessionID], &closerEntry{key: closerKey(closer), fn: closer})
}

// Unregister 实现 seam.SessionConnections：注销第一个匹配的 closer（幂等）；
// 集合清空后连同键一起摘除。
func (c *sessionConnections) Unregister(sessionID string, closer func()) {
	if closer == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entries := c.bySession[sessionID]
	key := closerKey(closer)
	for i, entry := range entries {
		if entry.key == key {
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

// closerKey 取函数值的 code pointer：同一函数值的多次调用结果恒定，Register 存的与
// Unregister 传的是同一值时必然匹配。
func closerKey(closer func()) uintptr {
	return reflect.ValueOf(closer).Pointer()
}
