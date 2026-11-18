package database

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// LegacyTaskLedger reads receipts from the retired database task runner.
type LegacyTaskLedger struct {
	StateDir string
}

type LegacyTaskReceipt struct {
	ID              string            `json:"id"`
	RequestID       string            `json:"requestId"`
	Action          string            `json:"action"`
	State           string            `json:"state"`
	Result          *legacyTaskResult `json:"result,omitempty"`
	CancelRequested bool              `json:"cancelRequested"`
	Message         string            `json:"message"`
}

type legacyTaskResult struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	Engine      string `json:"engine"`
	Name        string `json:"name"`
	ContainerID string `json:"containerId"`
	Version     string `json:"version"`
}

func legacyTaskID(requestID string) string {
	sum := sha256.Sum256([]byte(requestID))
	return hex.EncodeToString(sum[:])
}

// Read accepts either persisted identity and compares both when supplied.
func (l LegacyTaskLedger) Read(ctx context.Context, id, requestID string) (LegacyTaskReceipt, error) {
	if err := ctx.Err(); err != nil {
		return LegacyTaskReceipt{}, err
	}
	if id == "" && containerIDPattern.MatchString(requestID) {
		id = legacyTaskID(requestID)
	}
	if !containerIDPattern.MatchString(id) {
		return LegacyTaskReceipt{}, errors.New("旧数据库任务标识无效")
	}
	f, err := openNoFollow(filepath.Join(l.StateDir, "agent-database-tasks", id+".json"))
	if err != nil {
		return LegacyTaskReceipt{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return LegacyTaskReceipt{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > registrySizeLimit || info.Mode().Perm()&0077 != 0 || uidOf(info) != os.Getuid() {
		return LegacyTaskReceipt{}, errors.New("旧数据库任务文件权限或大小无效")
	}
	var task struct {
		LegacyTaskReceipt
		Input          json.RawMessage `json:"input"`
		Digest         string          `json:"digest"`
		RegistrationID string          `json:"registrationId"`
	}
	raw, err := io.ReadAll(io.LimitReader(f, registrySizeLimit+1))
	if err != nil {
		return LegacyTaskReceipt{}, err
	}
	if len(raw) > registrySizeLimit || json.Unmarshal(raw, &task) != nil || task.ID != id ||
		!containerIDPattern.MatchString(task.RequestID) || legacyTaskID(task.RequestID) != id ||
		(requestID != "" && task.RequestID != requestID) {
		return LegacyTaskReceipt{}, errors.New("旧数据库任务记录身份不匹配")
	}
	var input struct{ Action string }
	var compact bytes.Buffer
	if json.Unmarshal(task.Input, &input) != nil || json.Compact(&compact, task.Input) != nil ||
		input.Action != task.Action || (task.Action != "create" && task.Action != "reconcile") {
		return LegacyTaskReceipt{}, errors.New("旧数据库任务输入无效")
	}
	sum := sha256.Sum256(compact.Bytes())
	if hex.EncodeToString(sum[:]) != task.Digest {
		return LegacyTaskReceipt{}, errors.New("旧数据库任务输入摘要不匹配")
	}
	switch task.State {
	case "succeeded":
		if task.Result == nil || task.Result.ID == "" || (task.Action == "create" && task.Result.ID != task.RegistrationID) {
			return LegacyTaskReceipt{}, errors.New("旧数据库任务缺少完成回执")
		}
	case "running":
		task.State = "unknown"
		task.Message = "旧数据库任务已停止调度，原操作结果尚未核实"
	case "unknown":
	default:
		return LegacyTaskReceipt{}, errors.New("旧数据库任务状态无效")
	}
	return task.LegacyTaskReceipt, nil
}
