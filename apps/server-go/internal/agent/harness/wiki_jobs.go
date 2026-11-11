package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/harness/model"
)

type storedWikiJob struct {
	WikiJob
	Response *model.Response `json:"response,omitempty"`
}

func saveWikiJob(ctx context.Context, tx *sql.Tx, job WikiJob) error {
	job.Model = job.Model.Public()
	raw, err := json.Marshal(storedWikiJob{WikiJob: job, Response: job.Response})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO wiki_jobs(id,kind,origin_kind,origin_id,state,document,input) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, job.ID, job.Kind, job.OriginKind, job.OriginID, job.Status, string(raw), job.Input)
	return err
}

func readWikiJob(ctx context.Context, q rowReader, id string) (WikiJob, error) {
	var raw, input string
	err := q.QueryRowContext(ctx, "SELECT document,input FROM wiki_jobs WHERE id=?", id).Scan(&raw, &input)
	if errors.Is(err, sql.ErrNoRows) {
		return WikiJob{}, &Error{404, "memory-extraction-not-found", "长期记忆提炼任务不存在"}
	}
	if err != nil {
		return WikiJob{}, err
	}
	var stored storedWikiJob
	if err = json.Unmarshal([]byte(raw), &stored); err != nil {
		return WikiJob{}, err
	}
	stored.WikiJob.Input, stored.WikiJob.Response = input, stored.Response
	return stored.WikiJob, nil
}

func (m *Manager) recoverWikiJobs(ctx context.Context) error {
	return m.store.write(ctx, "wiki-extraction-recovery", func(tx *sql.Tx) error {
		if err := m.recoverEmbeddingRequests(ctx, tx, false, &Failure{Code: "memory-retired", Message: "长期记忆整理与索引功能已退役，任务不再执行或重试"}); err != nil {
			return err
		}
		jobs, err := readDocuments[storedWikiJob](ctx, tx, "SELECT document FROM wiki_jobs WHERE state IN ('queued','running')")
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
func (m *Manager) freezeWikiJobsForMaintenance(ctx context.Context, tx *sql.Tx) error {
	if err := m.recoverEmbeddingRequests(ctx, tx, true); err != nil {
		return err
	}
	jobs, err := readDocuments[storedWikiJob](ctx, tx, "SELECT document FROM wiki_jobs WHERE state IN ('queued','running')")
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
