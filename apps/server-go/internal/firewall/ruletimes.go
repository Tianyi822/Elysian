package firewall

import (
	"database/sql"
	"sync"

	// 纯 Go sqlite 驱动（固定选型 modernc.org/sqlite）；注册驱动名 "sqlite"。
	_ "modernc.org/sqlite"
)

// 防火墙规则时间账本（ruleTimesStore.ts 等价物）：落在部署机器 ~/.Elysian/data 下的
// firewall.sqlite，与 TS 版 bun:sqlite 同文件兼容（同一表、同一 upsert 语句）。
//
// 账本语义：时间按规范指纹（canonical id）记录，而指纹只含「规则是什么」，不含
// 「何时创建」。面板外删除后重建同规格的规则，指纹不变，读到的仍是旧时间；这份账本
// 对「同指纹规则的重建」不提供时间可靠性保证。
//
// 并发：bun:sqlite 是同步单连接；Go 侧用 SetMaxOpenConns(1) + 互斥锁对齐同一语义
//（go-plan §11 D3）。

const ruleTimesSchema = `
CREATE TABLE IF NOT EXISTS rule_touches (
  canonical_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);
`

// ruleTimes 时间账本接口（get/set/remove/close）。
type ruleTimes interface {
	Get(canonicalId string) (string, bool)
	Set(canonicalId, updatedAt string)
	Remove(canonicalId string)
	Close()
}

// ruleTimesStore modernc.org/sqlite 实现的时间账本。
type ruleTimesStore struct {
	db *sql.DB
	mu sync.Mutex
}

// openRuleTimesStore 打开（或创建）规则时间账本；Docker 下持久化在命名卷。
func openRuleTimesStore(path string) (*ruleTimesStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(ruleTimesSchema); err != nil {
		db.Close()
		return nil, err
	}
	return &ruleTimesStore{db: db}, nil
}

// Get 读取指纹的最近变更时间；无记录或值非字符串时回 未找到。
func (s *ruleTimesStore) Get(canonicalId string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var updatedAt string
	err := s.db.QueryRow("SELECT updated_at FROM rule_touches WHERE canonical_id = ?", canonicalId).Scan(&updatedAt)
	if err != nil {
		return "", false
	}
	return updatedAt, true
}

// Set 写入（或覆盖）指纹的最近变更时间。
func (s *ruleTimesStore) Set(canonicalId, updatedAt string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(
		"INSERT INTO rule_touches (canonical_id, updated_at) VALUES (?, ?) ON CONFLICT(canonical_id) DO UPDATE SET updated_at = excluded.updated_at",
		canonicalId, updatedAt,
	)
}

// Remove 删除指纹的时间记录。
func (s *ruleTimesStore) Remove(canonicalId string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec("DELETE FROM rule_touches WHERE canonical_id = ?", canonicalId)
}

// Close 关闭底层连接。
func (s *ruleTimesStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.db.Close()
}
