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
	ID        string                   `json:"id"`
	RequestID string                   `json:"requestId"`
	ImageRef  string                   `json:"imageRef"`
	State     string                   `json:"state"`
	CreatedAt string                   `json:"createdAt"`
	UpdatedAt string                   `json:"updatedAt"`
	Image     *contract.ContainerImage `json:"image,omitempty"`
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
			if err = config.AtomicJSON(file, &task); err != nil {
				return err
			}
		case "unknown", "succeeded":
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
	if err := a.check(ctx); err != nil {
		return AgentPullTask{}, err
	}
	index := strings.LastIndex(imageRef, ":")
	if index <= strings.LastIndex(imageRef, "/") || !containerIDPattern.MatchString(requestID) {
		return AgentPullTask{}, shared.InvalidRequest("拉取镜像需要固定名称、标签和请求标识")
	}
	body := convertJSONValue(map[string]any{"name": imageRef[:index], "tag": imageRef[index+1:]})
	if _, err := parsePullBody(body); err != nil {
		return AgentPullTask{}, err
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
		if existing.ImageRef != imageRef || existing.RequestID != requestID {
			return AgentPullTask{}, shared.InvalidRequest("请求标识已用于其他镜像")
		}
		return *existing, nil
	}
	for _, task := range a.pullTasks {
		if task.State != "succeeded" {
			return AgentPullTask{}, shared.InvalidRequest("已有进行中或结果未确认的镜像拉取任务")
		}
	}
	// Persist before dispatch. A lost response must never trigger a second pull.
	now := time.Now().UTC().Format(time.RFC3339)
	task := AgentPullTask{ID: id, RequestID: requestID, ImageRef: imageRef, State: "running", CreatedAt: now, UpdatedAt: now}
	if err := config.AtomicJSON(filepath.Join(a.taskRoot, id+".json"), &task); err != nil {
		return AgentPullTask{}, err
	}
	a.pullTasks[id] = &task
	background, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	if a.pullCancel == nil {
		a.pullCancel = map[string]context.CancelFunc{}
	}
	a.pullCancel[id] = cancel
	a.taskWG.Add(1)
	go func() {
		defer a.taskWG.Done()
		defer cancel()
		image, err := a.service.Pull(background, body, nil)
		a.taskMu.Lock()
		defer a.taskMu.Unlock()
		updated := task
		delete(a.pullCancel, id)
		updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		updated.State = "unknown"
		if err == nil {
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
	return *task, nil
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
	return a.service.SearchImages(ctx, term, registry)
}
func (a *AgentFacade) Tags(ctx context.Context, name, registry string) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	return a.service.ImageTags(ctx, name, registry)
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
