package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/contract"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

type AgentPullTask struct {
	ID           string                   `json:"id"`
	RequestID    string                   `json:"requestId"`
	ImageRef     string                   `json:"imageRef"`
	Registry     string                   `json:"registry,omitempty"`
	ErrorCode    string                   `json:"errorCode,omitempty"`
	ErrorMessage string                   `json:"errorMessage,omitempty"`
	State        string                   `json:"state"`
	CreatedAt    string                   `json:"createdAt"`
	UpdatedAt    string                   `json:"updatedAt"`
	Progress     *imagePullProgress       `json:"progress,omitempty"`
	Image        *contract.ContainerImage `json:"image,omitempty"`
}

func (a *AgentFacade) loadPullTasks() error {
	if a.pullTasks != nil {
		return nil
	}
	root := a.taskRoot
	if root == "" {
		root = filepath.Join(paths.StateDir, "agent-docker-tasks")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(root, "*.json"))
	if err != nil {
		return err
	}
	loaded := map[string]*AgentPullTask{}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var task AgentPullTask
		if json.Unmarshal(raw, &task) != nil || !containerIDPattern.MatchString(task.ID) || !containerIDPattern.MatchString(task.RequestID) || filepath.Base(file) != task.ID+".json" {
			return errors.New("镜像任务记录损坏")
		}
		switch task.State {
		case "running":
			task.State = "unknown"
			task.ErrorCode, task.ErrorMessage = "docker-pull-interrupted", "面板重启中断了镜像拉取，结果未确认，禁止重新拉取或换源重投"
			if err = config.AtomicJSON(file, &task); err != nil {
				return err
			}
		case "unknown", "succeeded", "failed":
		default:
			return errors.New("镜像任务状态无效")
		}
		loaded[task.ID] = &task
	}
	a.taskRoot, a.pullTasks = root, loaded
	return nil
}

func pullTaskID(requestID string) string {
	hash := sha256.Sum256([]byte(requestID))
	return hex.EncodeToString(hash[:])
}

func (a *AgentFacade) Pull(ctx context.Context, imageRef, requestID string) (AgentPullTask, error) {
	return a.PullFromRegistry(ctx, imageRef, requestID, "")
}

func (a *AgentFacade) PullFromRegistry(ctx context.Context, imageRef, requestID, registry string) (AgentPullTask, error) {
	if err := a.check(ctx); err != nil {
		return AgentPullTask{}, err
	}
	index := strings.LastIndex(imageRef, ":")
	if index <= strings.LastIndex(imageRef, "/") || !containerIDPattern.MatchString(requestID) {
		return AgentPullTask{}, &AgentError{Code: "docker-pull-invalid", Message: "拉取镜像需要固定名称、标签和请求标识", NotDispatched: true}
	}
	registry = strings.TrimSpace(registry)
	if _, embedded := embeddedRegistryHost(imageRef[:index]); embedded && registry != "" {
		return AgentPullTask{}, &AgentError{Code: "docker-registry-conflict", Message: "内嵌镜像源与独立 registry 参数不能同时使用", NotDispatched: true}
	}
	if registry != "" {
		host, err := parseRegistryInput(registry)
		if err != nil {
			return AgentPullTask{}, &AgentError{Code: "docker-registry-invalid", Message: "镜像源地址格式无效或不允许", NotDispatched: true}
		}
		registry = "https://" + strings.TrimSuffix(strings.ToLower(host), ":443")
		if isOfficialImageRegistry(registry) {
			registry = ""
		}
	}
	values := map[string]any{"name": imageRef[:index], "tag": imageRef[index+1:]}
	if registry != "" {
		values["registry"] = registry
	}
	body := convertJSONValue(values)
	if _, err := parsePullBody(body); err != nil {
		return AgentPullTask{}, &AgentError{Code: "docker-pull-invalid", Message: "镜像名称或标签格式无效", NotDispatched: true}
	}
	id := pullTaskID(requestID)
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if err := a.loadPullTasks(); err != nil {
		return AgentPullTask{}, err
	}
	if a.closed {
		return AgentPullTask{}, errors.New("镜像任务服务已停止")
	}
	if existing := a.pullTasks[id]; existing != nil {
		if existing.ImageRef != imageRef || existing.RequestID != requestID || existing.Registry != registry {
			return AgentPullTask{}, shared.InvalidRequest("请求标识已用于其他镜像")
		}
		return cloneAgentPullTask(*existing), nil
	}
	for _, task := range a.pullTasks {
		if task.State != "succeeded" && task.State != "failed" {
			return AgentPullTask{}, shared.InvalidRequest("已有进行中或结果未确认的镜像拉取任务")
		}
	}
	// Persist before dispatch. A lost response must never trigger a second pull.
	now := a.service.deps.now().UTC().Format(time.RFC3339Nano)
	task := AgentPullTask{ID: id, RequestID: requestID, ImageRef: imageRef, Registry: registry, State: "running", CreatedAt: now, UpdatedAt: now}
	if err := config.AtomicJSON(filepath.Join(a.taskRoot, id+".json"), &task); err != nil {
		return AgentPullTask{}, err
	}
	a.pullTasks[id] = &task
	background, cancel := context.WithTimeout(context.Background(), a.service.deps.agentPullTimeout)
	if a.pullCancel == nil {
		a.pullCancel = map[string]context.CancelFunc{}
	}
	a.pullCancel[id] = cancel
	a.taskWG.Add(1)
	go func() {
		defer a.taskWG.Done()
		defer cancel()
		var lastSaved time.Time
		image, err := a.service.pull(background, body, func(progress imagePullProgress) {
			a.recordPullProgress(id, progress, &lastSaved)
		}, true)
		a.taskMu.Lock()
		defer a.taskMu.Unlock()
		updated := cloneAgentPullTask(*a.pullTasks[id])
		delete(a.pullCancel, id)
		updated.UpdatedAt = a.service.deps.now().UTC().Format(time.RFC3339Nano)
		updated.State = "unknown"
		updated.ErrorCode, updated.ErrorMessage = "docker-pull-unknown", "镜像拉取结果未确认，禁止重新拉取或换源重投"
		if errors.Is(err, agentPullIdleError) {
			updated.ErrorCode, updated.ErrorMessage = "docker-pull-idle-timeout", "Docker 连续 5 分钟未返回拉取数据，结果未确认，禁止重新拉取或换源重投"
		} else if errors.Is(background.Err(), context.DeadlineExceeded) {
			updated.ErrorCode, updated.ErrorMessage = "docker-pull-timeout", "镜像拉取达到 2 小时安全上限，结果未确认，禁止重新拉取或换源重投"
		}
		if _, confirmed := err.(*pullConfirmedFailure); confirmed && background.Err() == nil {
			updated.State = "failed"
			updated.ErrorCode, updated.ErrorMessage = "docker-pull-failed", "镜像拉取已确认失败且处理已结束，可选择其他镜像源并使用新的 requestId 重试"
		}
		if err == nil {
			updated.ErrorCode, updated.ErrorMessage = "", ""
			updated.State = "succeeded"
			updated.Image = &image
		}
		if config.AtomicJSON(filepath.Join(a.taskRoot, id+".json"), &updated) == nil {
			a.pullTasks[id] = &updated
		}
	}()
	return task, nil
}

func (a *AgentFacade) InspectPull(ctx context.Context, id string) (AgentPullTask, error) {
	if err := ctx.Err(); err != nil {
		return AgentPullTask{}, err
	}
	if a == nil || a.service == nil {
		return AgentPullTask{}, errors.New("镜像服务不可用")
	}
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if err := a.loadPullTasks(); err != nil {
		return AgentPullTask{}, err
	}
	task := a.pullTasks[id]
	if task == nil {
		return AgentPullTask{}, errors.New("镜像任务不存在")
	}
	// Image presence cannot confirm this request completed or stopped. Only the
	// original Engine pull response may persist success; uncertainty stays held.
	return cloneAgentPullTask(*task), nil
}

func cloneAgentPullTask(task AgentPullTask) AgentPullTask {
	if task.Progress != nil {
		progress := *task.Progress
		if progress.CurrentBytes != nil {
			value := *progress.CurrentBytes
			progress.CurrentBytes = &value
		}
		if progress.TotalBytes != nil {
			value := *progress.TotalBytes
			progress.TotalBytes = &value
		}
		task.Progress = &progress
	}
	return task
}

// 仅保存最后一拍；展示写入失败不取消已派发的 Engine 请求，终态仍须原子保存。
func (a *AgentFacade) recordPullProgress(id string, progress imagePullProgress, lastSaved *time.Time) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	task := a.pullTasks[id]
	if task == nil || task.State != "running" {
		return
	}
	now := a.service.deps.now()
	updated := *task
	updated.Progress, updated.UpdatedAt = &progress, now.UTC().Format(time.RFC3339Nano)
	updated = cloneAgentPullTask(updated)
	a.pullTasks[id] = &updated
	if lastSaved.IsZero() || now.Sub(*lastSaved) >= time.Second {
		// 失败也节流，避免磁盘故障使每个进度帧都同步重试。
		*lastSaved = now
		_ = config.AtomicJSON(filepath.Join(a.taskRoot, id+".json"), &updated)
	}
}

func (a *AgentFacade) PullStatus(ctx context.Context, imageRef, id string, cancel bool) (AgentPullTask, error) {
	if err := a.check(ctx); err != nil {
		return AgentPullTask{}, err
	}
	task, err := a.InspectPull(ctx, id)
	if err != nil {
		return AgentPullTask{}, err
	}
	if task.ImageRef != imageRef {
		return AgentPullTask{}, shared.InvalidRequest("镜像任务不属于授权目标")
	}
	if cancel {
		a.taskMu.Lock()
		stop := a.pullCancel[id]
		a.taskMu.Unlock()
		if stop != nil {
			stop()
		}
	}
	return task, nil
}

func (a *AgentFacade) Close(ctx context.Context) error {
	if a == nil {
		return nil
	}
	a.taskMu.Lock()
	a.closed = true
	for _, cancel := range a.pullCancel {
		cancel()
	}
	a.taskMu.Unlock()
	done := make(chan struct{})
	go func() { a.taskWG.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *AgentFacade) LookupPull(ctx context.Context, requestID string) (AgentPullTask, error) {
	if !containerIDPattern.MatchString(requestID) {
		return AgentPullTask{}, shared.InvalidRequest("镜像请求标识无效")
	}
	task, err := a.InspectPull(ctx, pullTaskID(requestID))
	if err != nil {
		return AgentPullTask{}, err
	}
	if task.RequestID != requestID {
		return AgentPullTask{}, errors.New("镜像请求身份不匹配")
	}
	return task, nil
}

func AgentPullLogPage(task AgentPullTask, cursor string, limit int) (any, error) {
	page, err := shared.AgentLogPage([]any{map[string]any{"timestamp": task.CreatedAt, "stream": "status", "state": "accepted"}, map[string]any{"timestamp": task.UpdatedAt, "stream": "status", "state": task.State}}, cursor, limit)
	if err != nil {
		return nil, err
	}
	page["id"] = task.ID
	return page, nil
}

func (a *AgentFacade) Search(ctx context.Context, term, registry string) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	result, err := a.service.SearchImages(ctx, term, registry)
	return result, agentQueryError(ctx, err)
}
func (a *AgentFacade) Tags(ctx context.Context, name, registry string) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	result, err := a.service.ImageTags(ctx, name, registry)
	return result, agentQueryError(ctx, err)
}
func (a *AgentFacade) RemoveImage(ctx context.Context, id string) error {
	if err := a.check(ctx); err != nil {
		return err
	}
	if !strings.HasPrefix(id, "sha256:") || !containerIDPattern.MatchString(strings.TrimPrefix(id, "sha256:")) {
		return shared.InvalidRequest("Agent 删除镜像必须使用完整 sha256 ID")
	}
	return a.service.RemoveImage(ctx, id)
}

// CancelOwnedTask 仅供宿主删除会话后取消精确归属的任务。
func (a *AgentFacade) CancelOwnedTask(ctx context.Context, id, requestID string) error {
	task, err := a.InspectPull(ctx, id)
	if err != nil {
		return err
	}
	if requestID == "" || task.RequestID != requestID {
		return errors.New("镜像任务身份不匹配")
	}
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if stop := a.pullCancel[id]; stop != nil {
		stop()
	}
	return nil
}
