package harness

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

type storedWikiJob = sessionstore.StoredWikiJob

func (m *Manager) recoverWikiJobs(ctx context.Context) error {
	return writeStore(m.store, ctx, "wiki-extraction-recovery", func(tx sessionstore.Tx) error {
		if err := m.recoverEmbeddingRequests(ctx, tx, false, &Failure{Code: "memory-retired", Message: "长期记忆整理与索引功能已退役，任务不再执行或重试"}); err != nil {
			return err
		}
		jobs, err := tx.RecoverableWikiJobs(ctx)
		if err != nil {
			return err
		}
		for _, stored := range jobs {
			job := stored.WikiJob
			job.Response = stored.Response
			job.Status, job.MemoryStatus, job.EndedAt = StateInterrupted, "stale", wikiNow(m)
			job.Error = &Failure{Code: "memory-retired", Message: "长期记忆整理与索引功能已退役，任务不再执行或重试"}
			if err = saveWikiJob(ctx, tx, job); err != nil {
				return err
			}
		}
		return nil
	})
}

// 维护回滚冻结与工作流恢复共用事务；只有全部后台任务中断后才能消费 fence。
func (m *Manager) freezeWikiJobsForMaintenance(ctx context.Context, tx sessionstore.Tx) error {
	if err := m.recoverEmbeddingRequests(ctx, tx, true); err != nil {
		return err
	}
	jobs, err := tx.RecoverableWikiJobs(ctx)
	if err != nil {
		return err
	}
	for _, stored := range jobs {
		job := stored.WikiJob
		job.Response = stored.Response
		job.Status, job.MemoryStatus, job.EndedAt = StateInterrupted, "stale", wikiNow(m)
		job.Error = &Failure{Code: "maintenance-recovery", Message: "面板数据经过维护恢复，长期记忆后台任务已中断；核验来源后可重新提交"}
		if err = saveWikiJob(ctx, tx, job); err != nil {
			return err
		}
	}
	return nil
}
