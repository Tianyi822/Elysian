package containerapps

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/shared"
)

type AgentFacade struct {
	handler   Handler
	authorize func(context.Context) error
}

type AgentTaskStatus struct {
	State, RequestID string
	Terminal, Failed bool
	Value            any
	Error            string
}

func (a *AgentFacade) InspectTask(ctx context.Context, id string) (AgentTaskStatus, error) {
	if err := ctx.Err(); err != nil {
		return AgentTaskStatus{}, err
	}
	if a == nil || a.handler.Builds == nil {
		return AgentTaskStatus{}, errors.New("镜像构建任务服务不可用")
	}
	task, ok := a.handler.Builds.snapshotTask(id)
	if !ok {
		return AgentTaskStatus{}, errors.New("镜像构建任务不存在")
	}
	terminal := !blocksBuild(&task)
	message := ""
	if terminal && task.State != BuildStateSucceeded {
		message = "镜像构建任务未成功完成，请在容器应用页查看详情"
	}
	return AgentTaskStatus{State: task.State, RequestID: task.RequestID, Terminal: terminal, Failed: terminal && task.State != BuildStateSucceeded, Value: AgentBuildSummary(task), Error: message}, nil
}

func AgentBuildSummary(task BuildTask) any {
	results := make([]any, 0, len(task.Results))
	for _, result := range task.Results {
		results = append(results, map[string]any{"target": result.Target, "repository": result.Repository, "tag": result.Tag, "imageId": result.ImageID, "state": result.State})
	}
	return map[string]any{"id": task.ID, "requestId": task.RequestID, "slug": task.Slug, "mode": task.Mode, "state": task.State, "stage": task.Stage, "mayStillRun": task.MayStillRun, "createdAt": task.CreatedAt, "updatedAt": task.UpdatedAt, "results": results}
}

func (a *AgentFacade) BuildLogs(ctx context.Context, slug, id, cursor string, limit int) (any, error) {
	if err := a.Authorize(ctx); err != nil {
		return nil, err
	}
	if a.handler.Builds == nil {
		return nil, errors.New("镜像构建任务服务不可用")
	}
	task, err := a.handler.Builds.Get(slug, id)
	if err != nil {
		return nil, err
	}
	page, err := shared.AgentLogPage([]any{map[string]any{"timestamp": task.CreatedAt, "stream": "status", "state": BuildStateQueued}, map[string]any{"timestamp": task.UpdatedAt, "stream": "status", "state": task.State, "stage": task.Stage}}, cursor, limit)
	if err != nil {
		return nil, err
	}
	page["id"], page["rawWithheld"], page["reason"] = task.ID, true, "构建自由输出可能包含配置秘密；仅返回持久化结构化日志"
	return page, nil
}

func (a *AgentFacade) Preview(ctx context.Context, slug string, input BuildPlanInput) (any, error) {
	if err := a.Authorize(ctx); err != nil {
		return nil, err
	}
	if err := input.validateBuildInputShape(false); err != nil {
		return nil, err
	}
	if !a.handler.buildsReady() {
		return nil, errors.New("镜像构建服务不可用")
	}
	release, err := a.handler.Registry.LockWorkspace(ctx, slug)
	if err != nil {
		return nil, err
	}
	defer release()
	dir, err := a.handler.Registry.Directory(slug)
	if err != nil {
		return nil, err
	}
	if input.Mode == buildModeDockerfile {
		preview, err := PreviewDockerfileBuild(ctx, a.handler.Engine, dir, slug, input, a.handler.Policy)
		if err != nil {
			return nil, err
		}
		return map[string]any{"mode": preview.Mode, "slug": preview.Slug, "target": preview.Target, "dockerfile": preview.Dockerfile, "context": preview.Context, "imageRepository": preview.ImageRepository, "contextFiles": preview.ContextFiles, "contextBytes": preview.ContextBytes, "repositoryOccupied": preview.RepositoryOccupied, "warningCount": len(preview.Warnings)}, nil
	}
	preview, err := PreviewComposeBuild(ctx, a.handler.Engine, dir, slug, input.Compose, a.handler.Policy)
	if err != nil {
		return nil, err
	}
	services := make([]any, 0, len(preview.Services))
	for _, item := range preview.Services {
		services = append(services, map[string]any{"service": item.Service, "hasBuild": item.HasBuild, "target": item.Target, "dockerfile": item.Dockerfile, "context": item.Context, "imageRepository": item.ImageRepository, "contextFiles": item.ContextFiles, "contextBytes": item.ContextBytes, "repositoryOccupied": item.RepositoryOccupied, "warningCount": len(item.Warnings)})
	}
	return map[string]any{"mode": preview.Mode, "slug": preview.Slug, "compose": preview.Compose, "services": services, "warningCount": len(preview.Warnings)}, nil
}

func (a *AgentFacade) LookupTask(ctx context.Context, requestID string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if a == nil || a.handler.Builds == nil {
		return "", errors.New("镜像构建任务服务不可用")
	}
	m := a.handler.Builds
	m.mu.Lock()
	defer m.mu.Unlock()
	id := ""
	for _, task := range m.tasks {
		if task.RequestID == requestID {
			if id != "" {
				return "", errors.New("镜像请求匹配多个任务")
			}
			id = task.ID
		}
	}
	if id == "" {
		return "", errors.New("镜像请求尚未找到任务")
	}
	return id, nil
}

func NewAgentFacade(handler Handler, authorize func(context.Context) error) *AgentFacade {
	return &AgentFacade{handler: handler, authorize: authorize}
}
func (a *AgentFacade) Authorize(ctx context.Context) error {
	if a == nil || a.handler.Registry == nil || a.authorize == nil {
		return errors.New("容器应用 Agent 服务或派发授权不可用")
	}
	return a.authorize(ctx)
}

func AgentReadablePath(path string) bool {
	for _, part := range strings.Split(strings.ToLower(filepath.ToSlash(path)), "/") {
		if part == ".env" || strings.HasPrefix(part, ".env.") || part == ".ssh" || part == ".docker" || strings.HasSuffix(part, ".pem") || strings.HasSuffix(part, ".key") || strings.Contains(part, "credential") || strings.Contains(part, "secret") {
			return false
		}
	}
	return true
}

func AgentReadableContent(content string) bool {
	lower := strings.ToLower(content)
	for _, marker := range []string{"password", "passwd", "secret", "token", "credential", "private key", "private_key", "api_key", "api-key", "authorization", "access_key", "accesskey"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func (a *AgentFacade) Snapshot(ctx context.Context, slug string) (any, error) {
	if err := a.Authorize(ctx); err != nil {
		return nil, err
	}
	release, err := a.handler.Registry.LockWorkspace(ctx, slug)
	if err != nil {
		return nil, err
	}
	defer release()
	dir, err := a.handler.Registry.Directory(slug)
	if err != nil {
		return nil, err
	}
	digest, err := WorkspaceDigest(dir)
	if err != nil {
		return nil, err
	}
	return map[string]string{"slug": slug, "digest": digest}, nil
}

func (a *AgentFacade) Write(ctx context.Context, slug, path, content, expectedDigest string, remove bool) (any, error) {
	if err := a.Authorize(ctx); err != nil {
		return nil, err
	}
	if !AgentReadablePath(path) || !validWorkspaceDigest(expectedDigest) {
		return nil, shared.InvalidRequest("Agent 文件变更需要非秘密路径与有效内容快照")
	}
	release, err := a.handler.lockEditable(ctx, slug)
	if err != nil {
		return nil, err
	}
	defer release()
	dir, err := a.handler.Registry.Directory(slug)
	if err != nil {
		return nil, err
	}
	digest, err := WorkspaceDigest(dir)
	if err != nil {
		return nil, err
	}
	if digest != expectedDigest {
		return nil, &shared.InvalidRequestError{Status: http.StatusConflict, Message: "工作区内容已变化，请重新读取并审批"}
	}
	if remove {
		if err := DeleteFile(dir, path); err != nil {
			return nil, err
		}
		return map[string]bool{"removed": true}, nil
	}
	return WriteContent(dir, path, content)
}

func (a *AgentFacade) Create(ctx context.Context, slug, name string) (Record, error) {
	if err := a.Authorize(ctx); err != nil {
		return Record{}, err
	}
	release, err := a.handler.Registry.LockWorkspace(ctx, slug)
	if err != nil {
		return Record{}, err
	}
	defer release()
	return a.handler.Registry.Create(slug, name, time.Now())
}

func (a *AgentFacade) Remove(ctx context.Context, slug, expectedDigest string) error {
	if err := a.Authorize(ctx); err != nil {
		return err
	}
	if !validWorkspaceDigest(expectedDigest) {
		return shared.InvalidRequest("删除工作区需要有效内容快照")
	}
	release, err := a.handler.lockEditable(ctx, slug)
	if err != nil {
		return err
	}
	defer release()
	dir, err := a.handler.Registry.Directory(slug)
	if err != nil {
		return err
	}
	digest, err := WorkspaceDigest(dir)
	if err != nil {
		return err
	}
	if digest != expectedDigest {
		return &shared.InvalidRequestError{Status: http.StatusConflict, Message: "工作区内容已变化，请重新确认删除范围"}
	}
	return a.handler.Registry.Delete(slug)
}

func (a *AgentFacade) Submit(ctx context.Context, slug string, input BuildPlanInput) (BuildTask, error) {
	if err := a.Authorize(ctx); err != nil {
		return BuildTask{}, err
	}
	if err := input.validateBuildInputShape(true); err != nil {
		return BuildTask{}, err
	}
	if !validWorkspaceDigest(input.ExpectedDigest) || !a.handler.buildsReady() {
		return BuildTask{}, shared.InvalidRequest("Agent 构建需要工作区快照和可用构建服务")
	}
	dir, err := a.handler.Registry.Directory(slug)
	if err != nil {
		return BuildTask{}, err
	}
	task, _, err := a.handler.Builds.Submit(ctx, dir, slug, input)
	return task, err
}

func (a *AgentFacade) Cancel(ctx context.Context, slug, id string) (BuildTask, error) {
	if err := a.Authorize(ctx); err != nil {
		return BuildTask{}, err
	}
	if a.handler.Builds == nil {
		return BuildTask{}, errors.New("构建任务服务不可用")
	}
	task, err := a.handler.Builds.Get(slug, id)
	if err != nil {
		return BuildTask{}, err
	}
	if err = a.handler.Builds.Cancel(slug, id); err != nil {
		return BuildTask{}, err
	}
	return task, nil
}
