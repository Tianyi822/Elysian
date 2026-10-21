package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func (m *Manager) modelStoreLocked() (*model.Store, error) {
	if m.closed {
		return nil, closedError()
	}
	if m.deps.Profiles == nil {
		return nil, &Error{Status: 503, Code: "models-unavailable", Message: "模型配置服务不可用"}
	}
	return m.deps.Profiles, nil
}

func (m *Manager) ListModelProfiles() ([]model.Profile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return nil, err
	}
	return profiles.List(), nil
}
func (m *Manager) CreateModelProfile(input model.Input) (model.Profile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return model.Profile{}, err
	}
	return profiles.Create(input)
}
func (m *Manager) UpdateModelProfile(id string, revision int, input model.Input) (model.Profile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return model.Profile{}, err
	}
	return profiles.Update(id, revision, input)
}

func (m *Manager) ListModelServices() ([]model.Service, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return nil, err
	}
	return profiles.Services(), nil
}
func (m *Manager) CreateModelService(input model.ServiceInput) (model.Service, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return model.Service{}, err
	}
	return profiles.CreateService(input)
}
func (m *Manager) UpdateModelService(id string, revision int, input model.ServiceInput) (model.Service, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return model.Service{}, err
	}
	return profiles.UpdateService(id, revision, input)
}

func (m *Manager) DiscoverModels(ctx context.Context, input model.DiscoveryInput) ([]model.DiscoveredModel, error) {
	m.mu.Lock()
	profiles, err := m.modelStoreLocked()
	var profile model.Profile
	if err == nil {
		profile, err = profiles.DiscoveryProfile(input)
	}
	client := m.deps.ModelCatalog
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, &Error{Status: 503, Code: "model-catalog-unavailable", Message: "模型目录读取服务不可用"}
	}
	// 网络请求不持有内核锁，不占用 Agent 执行额度。
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return client.ListModels(callCtx, profile)
}

func (m *Manager) CreateSession(ctx context.Context, input CreateSessionInput) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return Session{}, err
	}
	if input.ModelRevision < 1 || input.ModelProfileID == "" {
		return Session{}, bad("invalid-model", "必须选择模型配置与明确版本")
	}
	if len(input.Title) > 200 {
		return Session{}, bad("invalid-title", "会话标题不能超过 200 字节")
	}
	profile, err := profiles.Resolve(input.ModelProfileID, input.ModelRevision, false)
	if err != nil {
		return Session{}, err
	}
	if !profile.Capabilities.Text || !profile.Capabilities.Tools {
		return Session{}, bad("model-capability", "所选模型必须支持文本与工具调用")
	}
	now := stamp(m.deps.Now())
	session := Session{WikiStrategy: wikiNavigationStrategy, ID: m.deps.NewID(), Title: strings.TrimSpace(input.Title), CreatedAt: now, LastActivityAt: now, ModelProfileID: profile.ID, ModelRevision: profile.Revision, LastSeq: "0"}
	if session.Title == "" {
		session.Title = "新会话"
	}
	err = m.store.createSession(ctx, session)
	return session, storageFailure(err)
}

func (m *Manager) SwitchSessionModel(ctx context.Context, id string, input SwitchModelInput) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return Session{}, err
	}
	if input.ModelRevision < 1 || input.ModelProfileID == "" {
		return Session{}, bad("invalid-model", "必须选择模型配置与明确版本")
	}
	next, err := profiles.Resolve(input.ModelProfileID, input.ModelRevision, false)
	if err != nil {
		return Session{}, err
	}
	if !next.Capabilities.Text || !next.Capabilities.Tools {
		return Session{}, bad("model-capability", "所选模型必须支持文本与工具调用")
	}
	previous, err := readSession(ctx, m.store.db, id)
	if err != nil {
		return Session{}, storageFailure(err)
	}
	old, oldErr := profiles.Resolve(previous.ModelProfileID, previous.ModelRevision, true)
	session, err := m.store.switchModel(ctx, id, input.ModelProfileID, input.ModelRevision)
	if err == nil && (previous.ModelProfileID != session.ModelProfileID || previous.ModelRevision != session.ModelRevision) {
		change := &ModelChange{After: next.Public(), Differences: []string{}, Notices: []string{"模型能力可能变化，请核对文本、工具调用和上下文容量", "切换后的首轮缓存命中率可能下降，实际取决于模型与供应商", "切换可能改变响应速度与调用成本，实际取决于模型与供应商"}}
		if oldErr == nil {
			public := old.Public()
			change.Before = &public
			if !reflect.DeepEqual(old.Capabilities, next.Capabilities) {
				change.Differences = append(change.Differences, "模型能力声明")
			}
			if old.ContextTokens != next.ContextTokens {
				change.Differences = append(change.Differences, "上下文 token 容量")
			}
			if old.OutputTokens != next.OutputTokens {
				change.Differences = append(change.Differences, "单次输出 token 上限")
			}
			if old.Model != next.Model || old.BaseURL != next.BaseURL || old.Provider != next.Provider || old.APIFormat != next.APIFormat {
				change.Differences = append(change.Differences, "模型、供应商、API 格式或服务地址")
			}
		} else {
			change.Differences = append(change.Differences, "原模型配置不可读取")
		}
		session.ModelChange = change
	}
	return session, storageFailure(err)
}

// RenameSession 只改标题：标题是纯展示字段，不进 Run 快照，运行中允许改名；
// 不更新 LastActivityAt，保持活动排序与活动游标边界稳定。
func (m *Manager) RenameSession(ctx context.Context, id string, input RenameSessionInput) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Session{}, closedError()
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return Session{}, bad("invalid-title", "会话标题不能为空")
	}
	if len(input.Title) > 200 {
		return Session{}, bad("invalid-title", "会话标题不能超过 200 字节")
	}
	session, err := m.store.renameSession(ctx, id, title)
	return session, storageFailure(err)
}

// DeleteSession 拒绝忙碌与存在结果未确认执行的会话；级联删除与保留期清理共用同一模板。
func (m *Manager) DeleteSession(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return closedError()
	}
	return storageFailure(m.store.deleteSession(ctx, id))
}

func (m *Manager) GetSession(ctx context.Context, id string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Session{}, closedError()
	}
	session, err := readSession(ctx, m.store.db, id)
	return session, storageFailure(err)
}
func (m *Manager) ListSessions(ctx context.Context, cursor string, limit int) (Page[Session], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Session]{}, closedError()
	}
	page, err := m.store.sessions(ctx, cursor, limit)
	return page, storageFailure(err)
}
func (m *Manager) ListSessionsByActivity(ctx context.Context, cursor string, limit int) (Page[Session], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Session]{}, closedError()
	}
	page, err := m.store.sessionsByActivity(ctx, cursor, limit)
	return page, storageFailure(err)
}
func (m *Manager) GetTask(ctx context.Context, id string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Task{}, closedError()
	}
	task, err := readTask(ctx, m.store.db, id)
	if err != nil {
		return task, storageFailure(err)
	}
	last, err := m.store.latestRun(ctx, id)
	if err != nil {
		return task, storageFailure(err)
	}
	task.LatestRun = last
	if last != nil {
		task.MemoryStatus = publicMemoryStatus(last)
	}
	return task, nil
}
func (m *Manager) ListTasks(ctx context.Context, sessionID, cursor string, limit int) (Page[Task], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Task]{}, closedError()
	}
	page, err := m.store.tasks(ctx, sessionID, cursor, limit)
	if err == nil {
		for i := range page.Items {
			last, readErr := m.store.latestRun(ctx, page.Items[i].ID)
			if readErr != nil {
				return page, storageFailure(readErr)
			}
			page.Items[i].LatestRun = last
			if last != nil {
				page.Items[i].MemoryStatus = publicMemoryStatus(last)
			}
		}
	}
	return page, storageFailure(err)
}
func (m *Manager) Messages(ctx context.Context, id, after string, limit int) (Page[Message], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Message]{}, closedError()
	}
	page, err := m.store.messages(ctx, id, after, limit)
	if err == nil {
		for i := range page.Items {
			v := &page.Items[i]
			v.Quarantined, err = wikiArtifactInvalid(ctx, m.store.db, "message", v.ID)
			if err != nil {
				break
			}
			v.WikiSources, err = wikiArtifactRefs(ctx, m.store.db, "message", v.ID)
			if err != nil {
				break
			}
		}
	}
	return page, storageFailure(err)
}
func (m *Manager) Memory(ctx context.Context, id string, revision int) (WorkingMemory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WorkingMemory{}, closedError()
	}
	memory, err := m.store.memory(ctx, id, revision)
	if err != nil {
		return memory, storageFailure(err)
	}
	last, err := m.store.latestRun(ctx, id)
	if err != nil {
		return memory, storageFailure(err)
	}
	if last != nil {
		memory.MemoryStatus = publicMemoryStatus(last)
	}
	invalid, e := wikiArtifactInvalid(ctx, m.store.db, "memory", id+":"+strconv.Itoa(memory.Revision))
	if e != nil {
		return memory, e
	}
	if invalid {
		memory.MemoryStatus = "invalidated"
	}
	return memory, nil
}
func (m *Manager) ModelRequests(ctx context.Context, id, cursor string, limit int) (Page[ModelRequestRecord], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[ModelRequestRecord]{}, closedError()
	}
	page, err := m.store.modelRequests(ctx, id, cursor, limit)
	if execution := m.executionLocked(id); err == nil && execution != nil && execution.agent != nil {
		agent := execution.agent
		for i := range page.Items {
			if page.Items[i].ID == agent.reasoningRequestID && page.Items[i].Status == StateRunning {
				page.Items[i].Reasoning = agent.reasoning
				page.Items[i].Content = agent.content
			}
		}
	}
	return page, storageFailure(err)
}

func (m *Manager) CreateTask(ctx context.Context, sessionID string, input AgentInput) (Run, bool, error) {
	return m.submitAgent(ctx, sessionID, input, true)
}
func (m *Manager) ContinueTask(ctx context.Context, taskID string, input AgentInput) (Run, bool, error) {
	return m.submitAgent(ctx, taskID, input, false)
}

func (m *Manager) submitAgent(ctx context.Context, targetID string, input AgentInput, newTask bool) (Run, bool, error) {
	if input.AuthorizationMode != "" && input.AuthorizationMode != AuthorizationOnDemand {
		return Run{}, false, bad("invalid-authorization-mode", "授权模式只能为 on-demand 或省略")
	}
	if input.ExtensionMode != "" && input.ExtensionMode != "enabled" {
		return Run{}, false, bad("invalid-extension-mode", "扩展模式只能为 enabled 或省略")
	}
	if _, err := normalizePermissionMode(input.PermissionMode); err != nil {
		return Run{}, false, err
	}
	if !requestPattern.MatchString(input.RequestID) {
		return Run{}, false, bad("invalid-request-id", "请求标识必须为 1 到 128 位字母、数字或 ._:-")
	}
	limits := m.deps.AgentLimits
	if strings.TrimSpace(input.Content) == "" || len(input.Content) > limits.UserBytes {
		return Run{}, false, bad("invalid-content", "用户输入为空或超过长度限制")
	}
	// 附件引用保序去重：重复 id 与去重后输入视为同一幂等键，不重复计数。
	input.Attachments = dedupeAttachmentRefs(input.Attachments)
	operation := "continue-task"
	if newTask {
		operation = "create-task"
	}
	raw, _ := json.Marshal(struct {
		AuthorizationMode string          `json:"authorizationMode,omitempty"`
		ExtensionMode     string          `json:"extensionMode,omitempty"`
		Operation         string          `json:"operation"`
		TargetID          string          `json:"targetId"`
		Content           string          `json:"content"`
		Skills            []RevisionRef   `json:"skills"`
		Resources         []ResourceRef   `json:"resources"`
		Prompts           []PromptRef     `json:"prompts"`
		Attachments       []AttachmentRef `json:"attachments,omitempty"`
		ReasoningLevel    string          `json:"reasoningLevel,omitempty"`
		ReplaceMessageID  string          `json:"replaceMessageId,omitempty"`
		PermissionMode    PermissionMode  `json:"permissionMode,omitempty"`
	}{input.AuthorizationMode, input.ExtensionMode, operation, targetID, input.Content, input.Skills, input.Resources, input.Prompts, input.Attachments, input.ReasoningLevel, input.ReplaceMessageID, canonicalPermissionMode(input.PermissionMode)})
	canonical := string(raw)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Run{}, false, closedError()
	}
	prior, priorInput, err := m.store.request(ctx, input.RequestID)
	if err != nil {
		return Run{}, false, storageFailure(err)
	}
	if prior.ID != "" {
		if priorInput != canonical {
			return Run{}, false, &Error{Status: 409, Code: "request-conflict", Message: "请求标识已用于不同的任务输入"}
		}
		return prior, true, nil
	}
	if newTask && input.ReplaceMessageID != "" {
		return Run{}, false, bad("invalid-replacement", "编辑重发必须使用原聊天任务续轮")
	}
	if err = m.agentAvailableLocked(); err != nil {
		return Run{}, false, err
	}
	profiles, err := m.modelStoreLocked()
	if err != nil {
		return Run{}, false, err
	}
	if err = m.promoteWorkflows(ctx); err != nil {
		return Run{}, false, storageFailure(err)
	}
	var task Task
	sessionID := targetID
	if !newTask {
		task, err = readTask(ctx, m.store.db, targetID)
		if err != nil {
			return Run{}, false, storageFailure(err)
		}
		sessionID = task.SessionID
		if task.Kind != "agent" || sessionID == "" {
			return Run{}, false, bad("invalid-task", "该任务不支持会话续轮")
		}
	}
	session, err := readSession(ctx, m.store.db, sessionID)
	if err != nil {
		return Run{}, false, storageFailure(err)
	}
	if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		return Run{}, false, &Error{Status: 409, Code: "session-busy", Message: "会话仍有任务排队或运行，请结束后再输入"}
	}
	profile, err := profiles.Resolve(session.ModelProfileID, session.ModelRevision, false)
	if err != nil {
		return Run{}, false, err
	}
	if !profile.Capabilities.Text || !profile.Capabilities.Tools {
		return Run{}, false, bad("model-capability", "所选模型必须支持文本与工具调用")
	}
	// 图片门禁对新建发送与编辑重发一视同仁：编辑重发携带原轮附件 id 同样过此检查。
	if len(input.Attachments) > 0 && !profile.Capabilities.Image {
		return Run{}, false, bad("image-unsupported", "当前模型不支持图片输入，请移除附件后重试")
	}
	if len(input.Attachments) > 0 {
		// 提交侧按 Limits 复检引用集合：逐 id 校验存在与绑定归属（未绑定或已绑定本会话，
		// 支撑编辑重发复用原轮 id），并按附件行 bytes 复核张数与总字节。
		rows, readErr := readAttachmentRows(ctx, m.store.db, input.Attachments, sessionID)
		if readErr != nil {
			if typed, ok := readErr.(*Error); ok {
				return Run{}, false, typed
			}
			return Run{}, false, storageFailure(readErr)
		}
		if err = validateAttachmentSet(rows, limits); err != nil {
			return Run{}, false, err
		}
	}
	if err = model.ValidateReasoningLevel(profile, input.ReasoningLevel); err != nil {
		return Run{}, false, err
	}
	now := stamp(m.deps.Now())
	if newTask {
		task = Task{ID: m.deps.NewID(), SessionID: sessionID, RequestID: input.RequestID, Kind: "agent", DriverVersion: "v2", CreatedAt: now, Goal: input.Content}
	}
	public := profile.Public()
	run := Run{ID: m.deps.NewID(), TaskID: task.ID, SessionID: sessionID, RequestID: input.RequestID, Input: input.Content, Model: &public, Status: StateQueued, CreatedAt: now, Limits: limits, LastSeq: "0", Phase: "queued", MemoryStatus: "stale"}
	env, err := m.environment(ctx, sessionID)
	if err != nil {
		return Run{}, false, storageFailure(err)
	}
	snapshot, err := m.snapshotForAgent(ctx, env, input.ExtensionMode, input.AuthorizationMode)
	if err != nil {
		return Run{}, false, err
	}
	if err = m.validateSelection(snapshot, input); err != nil {
		return Run{}, false, err
	}
	snapshot.PermissionMode, _ = normalizePermissionMode(input.PermissionMode)
	snapshot.Tools = append(snapshot.Tools, userInputCapability(), planCapability())
	snapshot.PolicyVersion = PermissionPolicyVersion
	if err = finalizeLoading(&snapshot, run, input.ReasoningLevel, env); err != nil {
		return Run{}, false, err
	}
	run.Selection = &input
	run.Snapshot = &snapshot
	if err = m.checkRetainedSkillBudget(ctx, run); err != nil {
		return Run{}, false, err
	}
	snapshot.Digest = ""
	snapshot.Digest = digestJSON(snapshot)
	run.DriverVersion = "v2"
	run.WikiStrategy = wikiNavigationStrategy
	run.Snapshot = &snapshot
	run.Selection = &input
	run, duplicate, err := m.store.acceptAgent(ctx, task, run, canonical, m.deps.NewID(), newTask)
	if err != nil {
		if _, ok := err.(*Error); !ok && ctx.Err() == nil {
			m.storageFailedLocked()
		}
		return Run{}, false, storageFailure(err)
	}
	m.signal()
	return run, duplicate, nil
}

func publicMemoryStatus(run *Run) string {
	if run.Status == StateQueued || run.Status == StateRunning || run.Status == StateWaitingInput || run.Status == StateWaitingApproval || run.Status == StateWaitingResource || run.Status == StateWaitingTask {
		run.MemoryStatus = "stale"
	}
	return run.MemoryStatus
}
