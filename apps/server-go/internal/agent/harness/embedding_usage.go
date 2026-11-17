package harness

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

// 调用时不持有 Manager 锁；网络前后持久化均在锁内完成。
func (m *Manager) embeddingComplete(ctx context.Context, profile EmbeddingProfile, input string, record EmbeddingRequest) ([]float64, error) {
	m.mu.Lock()
	if err := m.agentWritable(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if m.blocked != "" {
		m.mu.Unlock()
		return nil, bad("runtime-blocked", "运行派发已暂停")
	}
	record.ID, record.ProfileID, record.ProfileRevision = m.deps.NewID(), profile.ID, profile.Revision
	record.Status, record.StartedAt = StateRunning, wikiNow(m)
	record.InputBytes, record.InputDigest, record.EstimatedTokens = len(input), state.WikiDigest("embedding-input", input), len(input)+256
	err := writeStore(m.store, ctx, "embedding-request-start", func(tx sessionstore.Tx) error {
		if _, err := tx.FinishEmbeddingRequest(ctx, stamp(m.deps.Now().Add(-30*24*time.Hour))); err != nil {
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
	err = m.store.DispatchError()
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
	if e := writeStore(m.store, context.Background(), "embedding-request-finish", func(tx sessionstore.Tx) error { return saveEmbeddingRequest(context.Background(), tx, record) }); e != nil {
		if !m.closed {
			m.storageFailedLocked()
		}
		return nil, storageFailure(e)
	}
	return vector, err
}

func (m *Manager) recoverEmbeddingRequests(ctx context.Context, tx sessionstore.Tx, maintenance bool, reason ...*Failure) error {
	records, err := tx.PendingEmbeddingRequests(ctx)
	if err != nil {
		return err
	}
	for _, record := range records {
		record.Status, record.EndedAt = StateInterrupted, wikiNow(m)
		record.Error = &Failure{Code: "panel-restarted", Message: "面板重启中断了 Embedding 请求，未自动重试"}
		if maintenance {
			record.Error = &Failure{Code: "maintenance-recovery", Message: "面板数据经过维护恢复，Embedding 请求已隔离"}
		}
		if len(reason) > 0 {
			record.Error = reason[0]
		}
		if err = saveEmbeddingRequest(ctx, tx, record); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) sweepEmbeddingRequests(ctx context.Context) error {
	return writeStore(m.store, ctx, "embedding-request-retention", func(tx sessionstore.Tx) error {
		_, err := tx.FinishEmbeddingRequest(ctx, stamp(m.deps.Now().Add(-30*24*time.Hour)))
		return err
	})
}

func (m *Manager) ListEmbeddingRequests(ctx context.Context, cursor string, limit int) (Page[EmbeddingRequest], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[EmbeddingRequest]{}, closedError()
	}
	n, err := state.PageSize(limit, 50)
	if err != nil {
		return Page[EmbeddingRequest]{}, err
	}
	offset, err := state.NumberCursor(cursor)
	if err != nil {
		return Page[EmbeddingRequest]{}, err
	}
	return readView(ctx, m.store).EmbeddingRequests(ctx, offset, n)
}
