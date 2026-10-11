package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"elysian/server/internal/agent/harness/model"
)

// EmbeddingRequest 不保存输入正文或凭据，索引与查询用量均独立于 Agent 模型预算。
type EmbeddingRequest struct {
	ID              string      `json:"id"`
	ProfileID       string      `json:"profileId"`
	ProfileRevision int         `json:"profileRevision"`
	Purpose         string      `json:"purpose"`
	JobID           string      `json:"jobId,omitempty"`
	Page            *WikiRef    `json:"page,omitempty"`
	Status          string      `json:"status"`
	InputBytes      int         `json:"inputBytes"`
	InputDigest     string      `json:"inputDigest"`
	EstimatedTokens int         `json:"estimatedTokens"`
	Usage           model.Usage `json:"usage"`
	StartedAt       string      `json:"startedAt"`
	EndedAt         string      `json:"endedAt,omitempty"`
	Error           *Failure    `json:"error,omitempty"`
}

func saveEmbeddingRequest(ctx context.Context, tx *sql.Tx, record EmbeddingRequest) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO wiki_embedding_requests(id,state,document) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document", record.ID, record.Status, string(raw))
	return err
}

// 调用时不持有 Manager 锁；网络前后持久化均在锁内完成。
func (m *Manager) embeddingComplete(ctx context.Context, profile EmbeddingProfile, input string, record EmbeddingRequest) ([]float64, error) {
	m.mu.Lock()
	if err := m.workflowWritable(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if m.blocked != "" {
		m.mu.Unlock()
		return nil, bad("runtime-blocked", "运行派发已暂停")
	}
	record.ID, record.ProfileID, record.ProfileRevision = m.deps.NewID(), profile.ID, profile.Revision
	record.Status, record.StartedAt = StateRunning, wikiNow(m)
	record.InputBytes, record.InputDigest, record.EstimatedTokens = len(input), wikiDigest("embedding-input", input), len(input)+256
	err := m.store.write(ctx, "embedding-request-start", func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "DELETE FROM wiki_embedding_requests WHERE state<>'running' AND julianday(json_extract(document,'$.endedAt'))<julianday(?)", stamp(m.deps.Now().Add(-30*24*time.Hour))); err != nil {
			return err
		}
		return saveEmbeddingRequest(ctx, tx, record)
	})
	if err != nil {
		if ctx.Err() == nil {
			m.storageFailedLocked()
		}
		m.mu.Unlock()
		return nil, storageFailure(err)
	}
	m.mu.Unlock()
	var vector []float64
	var usage model.Usage
	err = m.store.recordsFault()
	if err == nil {
		vector, usage, err = embeddingCompleteHTTP(ctx, profile, input)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record.Usage, record.Status, record.EndedAt = usage, StateSucceeded, wikiNow(m)
	if err != nil {
		record.Status = StateFailed
		record.Error = &Failure{Code: "embedding-request-failed", Message: "Embedding 请求失败，未自动重试"}
	}
	if ctx.Err() != nil {
		err = ctx.Err()
		record.Status = StateInterrupted
		record.Error = &Failure{Code: "embedding-request-interrupted", Message: "Embedding 请求取消或超过时限"}
	}
	if e := m.store.write(context.Background(), "embedding-request-finish", func(tx *sql.Tx) error { return saveEmbeddingRequest(context.Background(), tx, record) }); e != nil {
		if !m.closed {
			m.storageFailedLocked()
		}
		return nil, storageFailure(e)
	}
	return vector, err
}

func (m *Manager) recoverEmbeddingRequests(ctx context.Context, tx *sql.Tx, maintenance bool) error {
	records, err := readDocuments[EmbeddingRequest](ctx, tx, "SELECT document FROM wiki_embedding_requests WHERE state='running'")
	if err != nil {
		return err
	}
	for _, record := range records {
		record.Status, record.EndedAt = StateInterrupted, wikiNow(m)
		record.Error = &Failure{Code: "panel-restarted", Message: "面板重启中断了 Embedding 请求，未自动重试"}
		if maintenance {
			record.Error = &Failure{Code: "maintenance-recovery", Message: "面板数据经过维护恢复，Embedding 请求已隔离"}
		}
		if err = saveEmbeddingRequest(ctx, tx, record); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) sweepEmbeddingRequests(ctx context.Context) error {
	return m.store.write(ctx, "embedding-request-retention", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM wiki_embedding_requests WHERE state<>'running' AND julianday(json_extract(document,'$.endedAt'))<julianday(?)", stamp(m.deps.Now().Add(-30*24*time.Hour)))
		return err
	})
}

func (m *Manager) ListEmbeddingRequests(ctx context.Context, cursor string, limit int) (Page[EmbeddingRequest], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[EmbeddingRequest]{}, closedError()
	}
	n, err := pageSize(limit, 50)
	if err != nil {
		return Page[EmbeddingRequest]{}, err
	}
	offset, err := numberCursor(cursor)
	if err != nil {
		return Page[EmbeddingRequest]{}, err
	}
	rows, err := m.store.db.QueryContext(ctx, "SELECT rowid,document FROM wiki_embedding_requests WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", offset, offset, n+1)
	if err != nil {
		return Page[EmbeddingRequest]{}, err
	}
	return documentPage[EmbeddingRequest](rows, n, 0, "")
}
