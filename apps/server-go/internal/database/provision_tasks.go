package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"syscall"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
	"elysian/server/internal/taskstore"
)

// Agent 数据库部署任务的持久账本：与 docker 域的容器操作账本同一套纪律（受理即落盘、
// 属主与权限校验、重启把执行中的任务置为未知、同一请求只对应一个任务）。

// ProvisionTaskDomain 是数据库部署的异步任务域。
const ProvisionTaskDomain = "database-provision"

// ProvisionState 是任务状态。
const (
	ProvisionRunning   = "running"
	ProvisionSucceeded = "succeeded"
	ProvisionFailed    = "failed"
	ProvisionUnknown   = "unknown"
)

// Effect 说明失败任务对业务的影响，供运行时决定是否解除保护。
const (
	ProvisionEffectNotDispatched = "not-dispatched" // 受理后、首个变更之前失败
	ProvisionEffectNoChange      = "no-change"      // 变更后已回滚并确认
	ProvisionEffectPartial       = "partial"        // 留下了已确认的变更
)

// provisionTimeout 是单个部署任务的执行上限（含实例就绪等待）。
const provisionTimeout = 10 * time.Minute

var provisionIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type provisionWrite struct {
	Stage      string `json:"stage"`
	InstanceID string `json:"instanceId,omitempty"`
	Volume     string `json:"volume,omitempty"`
	ExecID     string `json:"execId,omitempty"`
	Finished   bool   `json:"finished,omitempty"`
}

type provisionJournalKey struct{}

func recordProvisionWrite(ctx context.Context, write provisionWrite) error {
	if record, ok := ctx.Value(provisionJournalKey{}).(func(provisionWrite) error); ok {
		return record(write)
	}
	return nil
}

func (f *AgentFacade) recordProvisionWrite(id string, write provisionWrite) error {
	return f.updateProvision(id, func(task *ProvisionTask) {
		task.Writes = slices.Clone(task.Writes)
		if last := len(task.Writes) - 1; last >= 0 && task.Writes[last].Stage == write.Stage {
			task.Writes[last] = write
		} else {
			task.Writes = append(task.Writes, write)
		}
		if write.InstanceID != "" {
			task.InstanceID = write.InstanceID
		}
	})
}

// ProvisionTask 是一次数据库部署任务的持久记录。Result 只含回执投影，不含任何凭据值。
type ProvisionTask struct {
	ID           string          `json:"id"`
	RequestID    string          `json:"requestId"`
	Target       string          `json:"target"`
	InstanceID   string          `json:"instanceId,omitempty"`
	InstanceName string          `json:"instanceName,omitempty"`
	Digest       string          `json:"digest"`
	State        string          `json:"state"`
	Stage        string          `json:"stage"`
	Effect       string          `json:"effect,omitempty"`
	ErrorCode    string          `json:"errorCode,omitempty"`
	Message      string          `json:"message,omitempty"`
	Result       json.RawMessage `json:"result,omitempty"`
	UpdatedAt    string          `json:"updatedAt"`
	// CancelRequested 表示已请求停止；停止后的结果仍按 Effect 与 State 如实表达。
	CancelRequested bool                 `json:"cancelRequested,omitempty"`
	Writes          []provisionWrite     `json:"writes,omitempty"`
	Resolution      *ProvisionResolution `json:"resolution,omitempty"`
}

// ProvisionInputDigest preserves the original domain request identity.
func ProvisionInputDigest(input ProvisionInput) (string, error) {
	raw, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func ProvisionAgentReceipt(task ProvisionTask) ProvisionTask {
	task.Result = slices.Clone(task.Result)
	task.Writes, task.Resolution = nil, nil
	return task
}

func provisionID(requestID string) string {
	hash := sha256.Sum256([]byte(ProvisionTaskDomain + ":" + requestID))
	return hex.EncodeToString(hash[:])
}

// provisionBlocks 表示任务仍在执行或结果未确认，会阻止同一实例上的新部署。
func provisionBlocks(task ProvisionTask) bool {
	return task.State == ProvisionRunning || task.State == ProvisionUnknown && task.Resolution == nil
}

func (f *AgentFacade) loadProvisions() error {
	if f.operations != nil {
		return nil
	}
	root := f.operationRoot
	if root == "" {
		root = filepath.Join(paths.StateDir, "agent-database-provisions")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(root); err != nil {
		return err
	} else if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Getuid()) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("数据库部署任务目录身份或权限无效")
	}
	files, err := taskstore.Dir(root).Glob()
	if err != nil {
		return err
	}
	loaded := map[string]ProvisionTask{}
	for _, file := range files {
		raw, err := readProvisionRecord(file)
		if err != nil {
			return err
		}
		var task ProvisionTask
		if json.Unmarshal(raw, &task) != nil || task.ID != provisionID(task.RequestID) || !provisionIDPattern.MatchString(task.RequestID) || filepath.Base(file) != task.ID+".json" {
			return errors.New("数据库部署任务记录损坏")
		}
		switch task.State {
		case ProvisionRunning:
			task.State = ProvisionUnknown
			task.ErrorCode = "database-provision-interrupted"
			task.Message = "面板重启中断了数据库部署，结果未确认，禁止自动重投"
			task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if err := config.AtomicJSON(file, &task); err != nil {
				return err
			}
		case ProvisionSucceeded, ProvisionFailed, ProvisionUnknown:
		default:
			return errors.New("数据库部署任务状态无效")
		}
		loaded[task.ID] = task
	}
	f.operationRoot, f.operations = root, loaded
	f.operationCancel = map[string]context.CancelFunc{}
	return nil
}

func (f *AgentFacade) publishProvisionLocked(id string, task ProvisionTask) error {
	return taskstore.SaveAndPublish(taskstore.Dir(f.operationRoot), f.operations, id, task, config.AtomicJSON)
}

func (f *AgentFacade) stamp() string {
	if f.now != nil {
		return f.now().UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func (f *AgentFacade) updateProvision(id string, update func(*ProvisionTask)) error {
	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	task, ok := f.operations[id]
	if !ok {
		return errors.New("数据库部署任务不存在")
	}
	if task.Resolution != nil {
		return nil
	}
	update(&task)
	task.UpdatedAt = f.stamp()
	return f.publishProvisionLocked(id, task)
}

// InspectProvision 返回任务副本。
func (f *AgentFacade) InspectProvision(ctx context.Context, id string) (ProvisionTask, error) {
	if err := ctx.Err(); err != nil {
		return ProvisionTask{}, err
	}
	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	if err := f.loadProvisions(); err != nil {
		return ProvisionTask{}, err
	}
	task, ok := f.operations[id]
	if !ok {
		return ProvisionTask{}, shared.InvalidRequest("数据库部署任务不存在")
	}
	task.Result = slices.Clone(task.Result)
	task.Writes = slices.Clone(task.Writes)
	if task.Resolution != nil {
		resolution := *task.Resolution
		task.Resolution = &resolution
	}
	return task, nil
}

// LookupProvision 按请求编号找回任务。
func (f *AgentFacade) LookupProvision(ctx context.Context, requestID string) (ProvisionTask, error) {
	if !provisionIDPattern.MatchString(requestID) {
		return ProvisionTask{}, shared.InvalidRequest("请求标识无效")
	}
	return f.InspectProvision(ctx, provisionID(requestID))
}

// CancelProvision 请求停止任务；已发生的变更不回滚，停止后结果未确认仍保留保护。
func (f *AgentFacade) CancelProvision(ctx context.Context, id, requestID string) error {
	task, err := f.InspectProvision(ctx, id)
	if err != nil {
		return err
	}
	if task.RequestID != requestID {
		return errors.New("数据库部署请求身份不匹配")
	}
	if err := f.updateProvision(id, func(t *ProvisionTask) { t.CancelRequested = true }); err != nil {
		return err
	}
	f.operationMu.Lock()
	cancel := f.operationCancel[id]
	f.operationMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// Close 停止受理新部署并等待在途任务；ctx 结束时返回而不再等待。
func (f *AgentFacade) Close(ctx context.Context) error {
	f.operationMu.Lock()
	f.operationClosed = true
	for _, cancel := range f.operationCancel {
		cancel()
	}
	f.operationMu.Unlock()
	done := make(chan struct{})
	go func() { f.operationWG.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// SealUnacceptedProvision 是只在原提交者已退出后调用的恢复入口：账本确无该请求时落一张
// 失败回执封存它，迟到的同号提交因此不会再被执行；已有的原任务原样返回。
func (f *AgentFacade) SealUnacceptedProvision(ctx context.Context, input ProvisionInput) (ProvisionTask, error) {
	if ctx.Err() != nil {
		return ProvisionTask{}, ctx.Err()
	}
	requestID := input.RequestID
	if !provisionIDPattern.MatchString(requestID) {
		return ProvisionTask{}, errors.New("核实请求身份无效")
	}
	digest, err := ProvisionInputDigest(input)
	if err != nil {
		return ProvisionTask{}, err
	}
	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	if err := f.loadProvisions(); err != nil {
		return ProvisionTask{}, err
	}
	if err := f.verifyProvisionLedger(); err != nil {
		return ProvisionTask{}, err
	}
	id := provisionID(requestID)
	if task, ok := f.operations[id]; ok {
		if task.Digest != digest {
			return ProvisionTask{}, errors.New("核实请求与原任务不匹配")
		}
		return task, nil
	}
	task := ProvisionTask{ID: id, RequestID: requestID, Target: input.Engine + "/" + input.Version + "/" + input.Database, InstanceID: input.Instance, InstanceName: input.InstanceName,
		Digest: digest, State: ProvisionFailed, Stage: "not-accepted", Effect: ProvisionEffectNotDispatched, UpdatedAt: f.stamp(),
		ErrorCode: "database-provision-not-accepted", Message: "已核实原提交未被受理、业务变更未执行；原请求已封存，请修正参数后使用新的请求编号"}
	if err := f.publishProvisionLocked(id, task); err != nil {
		return ProvisionTask{}, err
	}
	return task, nil
}

// verifyProvisionLedger 在写否定回执前复核权威文件：缓存已满不代表文件完好。
// 调用方须持有 operationMu。
func (f *AgentFacade) verifyProvisionLedger() error {
	info, err := os.Lstat(f.operationRoot)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("数据库部署任务目录身份或权限无效")
	}
	files, err := taskstore.Dir(f.operationRoot).Glob()
	if err != nil {
		return err
	}
	if len(files) != len(f.operations) {
		return errors.New("数据库部署任务目录不完整，不能确认未受理")
	}
	for _, file := range files {
		raw, err := readProvisionRecord(file)
		if err != nil {
			return err
		}
		var record ProvisionTask
		if json.Unmarshal(raw, &record) != nil {
			return errors.New("数据库部署任务记录损坏，不能确认未受理")
		}
		cached, ok := f.operations[record.ID]
		left, leftErr := json.Marshal(record)
		right, rightErr := json.Marshal(cached)
		if !ok || filepath.Base(file) != record.ID+".json" || leftErr != nil || rightErr != nil || string(left) != string(right) {
			return errors.New("数据库部署任务记录已变化，不能确认未受理")
		}
	}
	return nil
}

func readProvisionRecord(path string) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 1<<20 {
		return nil, errors.New("数据库部署任务文件身份或权限无效")
	}
	return io.ReadAll(io.LimitReader(file, 1<<20))
}
