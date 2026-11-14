package docker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"elysian/server/internal/config"
)

// SealUnacceptedOperation is a host-only recovery gate. All accepted operations
// are written under operationMu before their worker can perform any mutation.
// The negative receipt uses the same identity and fences every late submit.
// It must only be called after the harness has observed the submitter exit.
func (a *AgentFacade) SealUnacceptedOperation(ctx context.Context, requestID, target string, input any) (ContainerOperationTask, error) {
	if ctx.Err() != nil {
		return ContainerOperationTask{}, ctx.Err()
	}
	if !agentOperationIDPattern.MatchString(requestID) || target == "" {
		return ContainerOperationTask{}, errors.New("核实请求身份无效")
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ContainerOperationTask{}, err
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	if err := a.loadContainerOperations(); err != nil {
		return ContainerOperationTask{}, err
	}
	if err := a.verifyContainerOperationLedger(); err != nil {
		return ContainerOperationTask{}, err
	}
	id := operationID(requestID)
	if task, ok := a.operations[id]; ok {
		if task.Digest != digest || task.Target != target {
			return ContainerOperationTask{}, errors.New("核实请求与原任务不匹配")
		}
		return task, nil
	}
	// Do not clear another request's protection or bypass an active task.
	for _, task := range a.operations {
		if task.Target == target && containerOperationBlocks(task) {
			return ContainerOperationTask{}, errors.New("目标仍有待核实的容器操作")
		}
	}
	task := ContainerOperationTask{ID: id, RequestID: requestID, Target: target, Digest: digest, State: "failed", Stage: "not-accepted", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), ErrorCode: "docker-operation-not-accepted", Message: "已核实原提交未被受理、业务变更未执行；原请求已封存，请修正参数后使用新的请求编号"}
	if err := config.AtomicJSON(filepath.Join(a.operationRoot, id+".json"), task); err != nil {
		return ContainerOperationTask{}, err
	}
	a.operations[id] = task
	return task, nil
}

// Recheck the authoritative files even when the live cache is populated. A
// missing, replaced or damaged receipt is not evidence of non-acceptance.
// Call with operationMu held, before writing a negative receipt.
func (a *AgentFacade) verifyContainerOperationLedger() error {
	info, err := os.Lstat(a.operationRoot)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("容器操作任务目录身份或权限无效")
	}
	files, err := filepath.Glob(filepath.Join(a.operationRoot, "*.json"))
	if err != nil {
		return err
	}
	if len(files) != len(a.operations) {
		return errors.New("容器操作任务目录不完整，不能确认未受理")
	}
	for _, file := range files {
		raw, err := readContainerOperationRecord(file)
		if err != nil {
			return err
		}
		var record ContainerOperationTask
		if json.Unmarshal(raw, &record) != nil {
			return errors.New("容器操作任务记录损坏")
		}
		cached, ok := a.operations[record.ID]
		left, leftErr := json.Marshal(record)
		right, rightErr := json.Marshal(cached)
		if !ok || filepath.Base(file) != record.ID+".json" || leftErr != nil || rightErr != nil || !bytes.Equal(left, right) {
			return errors.New("容器操作任务记录已变化，不能确认未受理")
		}
	}
	return nil
}
