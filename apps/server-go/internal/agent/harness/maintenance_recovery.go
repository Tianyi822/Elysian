package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"elysian/server/internal/agent/jsonvalue"
)

func readWorkflowRecoveryFence(path string) (bool, error) {
	if path == "" {
		return false, nil
	}
	info, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
		return false, errors.New("工作流维护冻结标记无效")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	var record struct {
		Version   int    `json:"version"`
		Reason    string `json:"reason"`
		CreatedAt string `json:"createdAt"`
	}
	if _, err := jsonvalue.Object(raw); err != nil {
		return false, errors.New("工作流维护冻结标记 JSON 无效")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil || record.Version != 1 || record.Reason != "panel-rollback" {
		return false, errors.New("工作流维护冻结标记无效")
	}
	if _, err := time.Parse(time.RFC3339Nano, record.CreatedAt); err != nil {
		return false, errors.New("工作流维护冻结标记时间无效")
	}
	return true, nil
}

func removeWorkflowRecoveryFence(path string) error {
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (m *Manager) recoverMaintenance(ctx context.Context) error {
	fence, err := readWorkflowRecoveryFence(m.deps.WorkflowRecoveryFence)
	if err != nil || !fence {
		return err
	}
	if err := m.store.write(ctx, "maintenance-recovery", func(tx *sql.Tx) error {
		return m.freezeWikiJobsForMaintenance(ctx, tx)
	}); err != nil {
		return err
	}
	return removeWorkflowRecoveryFence(m.deps.WorkflowRecoveryFence)
}
