package docker

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
	"strings"
	"syscall"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const ContainerOperationDomain = "docker-container-operation"

var agentOperationIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type ContainerExecInput struct {
	ID             string                    `json:"id"`
	RequestID      string                    `json:"requestId"`
	Argv           []string                  `json:"argv,omitempty"`
	Workdir        string                    `json:"workdir,omitempty"`
	DatabaseChange *seam.AgentDatabaseChange `json:"databaseChange,omitempty"`
}

type ContainerOperationTask struct {
	ID              string                        `json:"id"`
	RequestID       string                        `json:"requestId"`
	Target          string                        `json:"target"`
	Digest          string                        `json:"digest"`
	State           string                        `json:"state"`
	Stage           string                        `json:"stage"`
	UpdatedAt       string                        `json:"updatedAt"`
	CancelRequested bool                          `json:"cancelRequested"`
	Result          json.RawMessage               `json:"result,omitempty"`
	Message         string                        `json:"message,omitempty"`
	ErrorCode       string                        `json:"errorCode,omitempty"`
	ExecID          string                        `json:"execId,omitempty"`
	Resolution      *ContainerOperationResolution `json:"resolution,omitempty"`
}

type ContainerOperationResolution struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	RequestID string `json:"requestId"`
	Target    string `json:"target"`
	Digest    string `json:"digest"`
	Decision  string `json:"decision"`
	Evidence  string `json:"evidence"`
}

// AgentOperationReceipt excludes private administrative reconciliation evidence.
func AgentOperationReceipt(task ContainerOperationTask) ContainerOperationTask {
	task.Resolution = nil
	return task
}

func (a *AgentFacade) SetDatabaseContainers(bridge seam.AgentDatabaseContainers) {
	a.databaseContainers = bridge
}

func (a *AgentFacade) SetWebsiteContainers(bridge seam.AgentWebsiteContainers) {
	a.websiteContainers = bridge
}

func operationID(requestID string) string {
	hash := sha256.Sum256([]byte(ContainerOperationDomain + ":" + requestID))
	return hex.EncodeToString(hash[:])
}

func (a *AgentFacade) loadContainerOperations() error {
	if a.operations != nil {
		return nil
	}
	root := a.operationRoot
	if root == "" {
		root = filepath.Join(paths.StateDir, "agent-container-operations")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(root); err != nil {
		return err
	} else {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != uint32(os.Getuid()) || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
			return errors.New("容器操作任务目录身份或权限无效")
		}
	}
	files, err := filepath.Glob(filepath.Join(root, "*.json"))
	if err != nil {
		return err
	}
	loaded := map[string]ContainerOperationTask{}
	for _, file := range files {
		raw, err := readContainerOperationRecord(file)
		if err != nil {
			return err
		}
		var task ContainerOperationTask
		if json.Unmarshal(raw, &task) != nil || task.ID != operationID(task.RequestID) || !agentOperationIDPattern.MatchString(task.RequestID) || filepath.Base(file) != task.ID+".json" || task.ExecID != "" && !agentOperationIDPattern.MatchString(task.ExecID) {
			return errors.New("容器操作任务记录损坏")
		}
		if task.Resolution != nil && (!validContainerResolution(*task.Resolution, task) || task.State != "unknown" && task.State != "succeeded" && task.State != "failed") {
			return errors.New("容器操作核实记录身份无效")
		}
		switch task.State {
		case "running":
			task.State = "unknown"
			task.Message = "面板重启中断了容器操作，结果未确认，禁止自动重投"
			task.ErrorCode = "docker-container-operation-interrupted"
			task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if err := config.AtomicJSON(file, &task); err != nil {
				return err
			}
		case "succeeded", "failed", "unknown":
		default:
			return errors.New("容器操作任务状态无效")
		}
		loaded[task.ID] = task
	}
	a.operationRoot, a.operations = root, loaded
	a.operationCancel = map[string]context.CancelFunc{}
	return nil
}

func (a *AgentFacade) updateContainerOperation(id string, update func(*ContainerOperationTask)) error {
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	task, ok := a.operations[id]
	if !ok {
		return errors.New("容器操作任务不存在")
	}
	if task.Resolution != nil {
		return nil
	} // A late receipt cannot reopen an administratively resolved task.
	update(&task)
	task.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := config.AtomicJSON(filepath.Join(a.operationRoot, id+".json"), &task); err != nil {
		return err
	}
	a.operations[id] = task
	return nil
}

func (a *AgentFacade) submitContainerOperation(requestID, target string, input any, run func(context.Context, string) (any, error)) (ContainerOperationTask, error) {
	if !agentOperationIDPattern.MatchString(requestID) {
		return ContainerOperationTask{}, &AgentError{Code: "docker-operation-invalid", Message: "容器操作需要稳定的64位小写十六进制requestId", NotDispatched: true}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ContainerOperationTask{}, err
	}
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	id := operationID(requestID)
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	if err := a.loadContainerOperations(); err != nil {
		return ContainerOperationTask{}, err
	}
	if a.operationClosed {
		return ContainerOperationTask{}, errors.New("容器操作服务已停止")
	}
	if task, ok := a.operations[id]; ok {
		if task.Digest != digest || task.Target != target {
			return ContainerOperationTask{}, shared.InvalidRequest("requestId已用于其他容器操作")
		}
		return task, nil
	}
	for _, task := range a.operations {
		if task.Target == target && (task.State == "running" || task.State == "unknown") && task.Resolution == nil {
			return ContainerOperationTask{}, shared.InvalidRequest("此容器已有进行中或结果未确认的操作")
		}
	}
	task := ContainerOperationTask{ID: id, RequestID: requestID, Target: target, Digest: digest, State: "running", Stage: "accepted", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := config.AtomicJSON(filepath.Join(a.operationRoot, id+".json"), &task); err != nil {
		return ContainerOperationTask{}, err
	}
	a.operations[id] = task
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	a.operationCancel[id] = cancel
	a.operationWG.Add(1)
	go func() {
		defer a.operationWG.Done()
		defer cancel()
		defer func() { a.operationMu.Lock(); delete(a.operationCancel, id); a.operationMu.Unlock() }()
		var result any
		var runErr error
		func() {
			defer func() {
				if recover() != nil {
					runErr = errors.New("容器操作内部失败")
				}
			}()
			if runErr = a.updateContainerOperation(id, func(t *ContainerOperationTask) { t.Stage = "dispatched" }); runErr == nil {
				result, runErr = run(ctx, id)
			}
		}()
		_ = a.updateContainerOperation(id, func(t *ContainerOperationTask) {
			if runErr != nil {
				t.State = "unknown"
				t.ErrorCode = "docker-container-operation-unknown"
				t.Message = "容器操作结果未确认，请核实实际状态，禁止自动重试"
				if safe, ok := runErr.(*seam.AgentContainerError); ok {
					t.Message = safe.Message
					t.ErrorCode = safe.Code
					if safe.NotDispatched || safe.NoBusinessEffect {
						t.State = "failed"
					}
				}
				return
			}
			value, marshalErr := json.Marshal(result)
			if marshalErr != nil {
				t.State = "unknown"
				t.ErrorCode = "docker-container-operation-result-unpersisted"
				t.Message = "容器操作回执保存失败"
				return
			}
			t.State = "succeeded"
			t.Stage = "completed"
			t.Result = value
		})
	}()
	return task, nil
}

func (a *AgentFacade) SubmitService(ctx context.Context, input AgentServiceCreateInput) (ContainerOperationTask, error) {
	if err := a.check(ctx); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if prior, found, err := a.existingContainerOperation(input.RequestID, "name:"+input.Name, input); found || err != nil {
		return prior, agentSubmitRejected(err)
	}
	if _, err := a.validateServiceInput(input); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	imageID, err := a.resolveAgentImage(ctx, input.Image)
	if err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	var run func(context.Context) (any, error)
	if a.databaseContainers != nil {
		var handled bool
		run, handled, err = a.databaseContainers.PrepareCreate(ctx, input, imageID)
		if err != nil {
			return ContainerOperationTask{}, agentSubmitRejected(err)
		}
		if !handled {
			run = nil
		}
	}
	if run == nil {
		run = func(ctx context.Context) (any, error) { return a.createServiceAuthorized(ctx, input) }
	}
	return a.submitContainerOperation(input.RequestID, "name:"+input.Name, input, func(ctx context.Context, _ string) (any, error) { return run(ctx) })
}

func (a *AgentFacade) SubmitExec(ctx context.Context, input ContainerExecInput) (ContainerOperationTask, error) {
	if err := a.check(ctx); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if prior, found, err := a.existingContainerOperation(input.RequestID, input.ID, input); found || err != nil {
		return prior, agentSubmitRejected(err)
	}
	if _, err := agentObjectID(input.ID, false); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if err := a.CheckContainerMutation(ctx, input.ID, "", ""); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if (len(input.Argv) > 0) == (input.DatabaseChange != nil) || input.DatabaseChange != nil && input.Workdir != "" || len(input.Argv) > 64 || len(input.Workdir) > 1024 || strings.ContainsRune(input.Workdir, 0) {
		return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("argv与databaseChange必须且只能提供一项，workdir仅用于argv"))
	}
	for _, arg := range input.Argv {
		if len(arg) > 16384 || strings.ContainsRune(arg, 0) {
			return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("容器命令参数无效或超限"))
		}
	}
	if input.Workdir != "" && !strings.HasPrefix(input.Workdir, "/") {
		return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("容器工作目录必须为绝对路径"))
	}
	if input.DatabaseChange != nil {
		if a.databaseContainers == nil {
			return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("数据库登记能力不可用"))
		}
		run, err := a.databaseContainers.PrepareChange(ctx, input.ID, input.RequestID, *input.DatabaseChange)
		if err != nil {
			return ContainerOperationTask{}, agentSubmitRejected(err)
		}
		return a.submitContainerOperation(input.RequestID, input.ID, input, func(ctx context.Context, _ string) (any, error) { return run(ctx) })
	}
	if len(input.Argv) == 0 || input.Argv[0] == "" {
		return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("容器命令不能为空"))
	}
	if a.databaseContainers != nil {
		registered, err := a.databaseContainers.Registered(ctx, input.ID)
		if err != nil {
			return ContainerOperationTask{}, agentSubmitRejected(err)
		}
		if registered {
			return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("受管数据库仅允许结构化databaseChange；诊断请使用inspect与logs"))
		}
	}
	if _, err := a.safeTarget(ctx, input.ID); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	return a.submitContainerOperation(input.RequestID, input.ID, input, func(ctx context.Context, id string) (any, error) { return a.executeContainerCommand(ctx, id, input) })
}

// CheckContainerMutation shares the persistent task barrier with page services.
// It does not consume a dispatch authorization or mutate task state.
func (a *AgentFacade) CheckContainerMutation(ctx context.Context, id, name, ownRequestID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	a.operationMu.Lock()
	if err := a.loadContainerOperations(); err != nil {
		a.operationMu.Unlock()
		return err
	}
	needsName := false
	for _, task := range a.operations {
		if task.RequestID == ownRequestID || task.Resolution != nil || task.State != "running" && task.State != "unknown" {
			continue
		}
		if id != "" && task.Target == id || name != "" && task.Target == "name:"+name {
			a.operationMu.Unlock()
			return &shared.InvalidRequestError{Status: 409, Message: "此容器有进行中或结果未确认的操作，请先核实实际状态"}
		}
		needsName = needsName || strings.HasPrefix(task.Target, "name:")
	}
	a.operationMu.Unlock()
	if id != "" && name == "" && needsName {
		if _, err := agentObjectID(id, false); err != nil {
			return err
		}
		value, err := a.service.inspectContainerByID(ctx, id, actionTimeout)
		if err != nil {
			return err
		}
		row, _ := asRecord(value)
		name, _ = asString(mustGet(row, "Name"))
		name = strings.TrimPrefix(name, "/")
		if name == "" {
			return errors.New("容器名称身份不可核验")
		}
		return a.CheckContainerMutation(ctx, id, name, ownRequestID)
	}
	return nil
}

func (a *AgentFacade) InspectContainerOperation(ctx context.Context, id string) (ContainerOperationTask, error) {
	if err := ctx.Err(); err != nil {
		return ContainerOperationTask{}, err
	}
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	if err := a.loadContainerOperations(); err != nil {
		return ContainerOperationTask{}, err
	}
	task, ok := a.operations[id]
	if !ok {
		return ContainerOperationTask{}, shared.InvalidRequest("容器操作任务不存在")
	}
	task.Result = append(json.RawMessage(nil), task.Result...)
	if task.Resolution != nil {
		copy := *task.Resolution
		task.Resolution = &copy
	}
	return task, nil
}
func (a *AgentFacade) LookupContainerOperation(ctx context.Context, requestID string) (ContainerOperationTask, error) {
	return a.InspectContainerOperation(ctx, operationID(requestID))
}
func (a *AgentFacade) CancelContainerOperation(ctx context.Context, id, requestID string) error {
	task, err := a.InspectContainerOperation(ctx, id)
	if err != nil {
		return err
	}
	if task.RequestID != requestID {
		return errors.New("容器操作请求身份不匹配")
	}
	if err := a.updateContainerOperation(id, func(t *ContainerOperationTask) { t.CancelRequested = true }); err != nil {
		return err
	}
	a.operationMu.Lock()
	cancel := a.operationCancel[id]
	a.operationMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}
func (a *AgentFacade) closeContainerOperations(ctx context.Context) error {
	a.operationMu.Lock()
	a.operationClosed = true
	for _, cancel := range a.operationCancel {
		cancel()
	}
	a.operationMu.Unlock()
	done := make(chan struct{})
	go func() { a.operationWG.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *AgentFacade) existingContainerOperation(requestID, target string, input any) (ContainerOperationTask, bool, error) {
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	if err := a.loadContainerOperations(); err != nil {
		return ContainerOperationTask{}, false, err
	}
	task, ok := a.operations[operationID(requestID)]
	if !ok {
		return ContainerOperationTask{}, false, nil
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return ContainerOperationTask{}, true, err
	}
	sum := sha256.Sum256(raw)
	if task.Digest != hex.EncodeToString(sum[:]) || task.Target != target {
		return ContainerOperationTask{}, true, shared.InvalidRequest("requestId已用于其他容器操作")
	}
	return task, true, nil
}

func readContainerOperationRecord(path string) ([]byte, error) {
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
	if !ok || stat.Uid != uint32(os.Getuid()) || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4<<20 {
		return nil, errors.New("容器操作任务文件身份或权限无效")
	}
	return io.ReadAll(io.LimitReader(file, 4<<20))
}
