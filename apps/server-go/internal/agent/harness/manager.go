package harness

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

type ToolInvoker interface {
	Available() bool
	Schemas() []tools.PublicSchema
	Execute(context.Context, string, map[string]any) (any, error)
}

type Deps struct {
	WorkflowRecoveryFence string
	DispatchGuard         func() error
	Workspaces            *workspace.Store
	Catalog               CapabilityCatalog
	Profiles              *model.Store
	ModelClient           model.Client
	ModelCatalog          model.CatalogClient
	AgentLimits           Limits
	ModelConfigError      string
	Path                  string
	EmbeddingConfigPath   string
	Tools                 ToolInvoker
	Limits                Limits
	Now                   func() time.Time
	NewID                 func() string
	Spawn                 func(context.Context) (worker.Process, error)
}

// Manager 是父进程的唯一状态写入者。Worker 的消息只能提出请求，不能指定终态。
type Manager struct {
	executions   map[string]*executionState
	workers      []*workerSlot
	probes       sync.WaitGroup
	mu           sync.Mutex
	store        *store
	deps         Deps
	ctx          context.Context
	cancel       context.CancelFunc
	wake         chan struct{}
	done         chan struct{}
	wikiDone     chan struct{}
	closed       bool
	workerState  string
	activeID     string
	finishing    bool
	blocked      string
	storageError bool
	unresponsive bool
	closeOnce    sync.Once
	closeDone    chan struct{}
	closeErr     error
}

// executionLocked returns the in-memory execution projection for a run.
// Callers must hold Manager.mu; the projection is deliberately kept out of
// persistence because it only contains cancellation and protocol state.
func (m *Manager) executionLocked(runID string) *executionState {
	return m.executions[runID]
}

func New(deps Deps) (*Manager, error) {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.NewID == nil {
		deps.NewID = randomID
	}
	if deps.Limits == (Limits{}) {
		deps.Limits = DefaultLimits()
	}
	if err := validateLimits(deps.Limits); err != nil {
		return nil, err
	}
	if deps.AgentLimits == (Limits{}) {
		deps.AgentLimits = DefaultAgentLimits()
	}
	if err := validateAgentLimits(deps.AgentLimits); err != nil {
		return nil, err
	}
	if deps.ModelClient == nil {
		deps.ModelClient = model.NewClient(nil)
	}
	if deps.ModelCatalog == nil {
		deps.ModelCatalog = model.NewCatalogClient(nil)
	}
	if deps.Spawn == nil {
		deps.Spawn = func(ctx context.Context) (worker.Process, error) { return worker.Spawn(ctx, worker.Options{}) }
	}
	s, err := openStore(deps.Path, deps.Now)
	if err != nil {
		return nil, err
	}
	if err = s.recover(context.Background()); err == nil {
		err = (&Manager{store: s, deps: deps}).recoverWorkflows(context.Background())
	}
	if err == nil {
		err = (&Manager{store: s, deps: deps}).sweep(context.Background())
	}
	if err == nil {
		err = (&Manager{store: s, deps: deps}).recoverWikiJobs(context.Background())
	}
	if err == nil {
		err = s.recordsFault()
	}
	if err != nil {
		_ = s.close()
		return nil, fmt.Errorf("恢复运行记录失败：%w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{store: s, deps: deps, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), done: make(chan struct{}), wikiDone: make(chan struct{}), closeDone: make(chan struct{}), workerState: "starting", executions: make(map[string]*executionState)}
	if err = m.restoreExecutionRevocations(ctx); err != nil {
		cancel()
		_ = s.close()
		return nil, fmt.Errorf("恢复执行授权撤销状态失败：%w", err)
	}
	go m.loop()
	go m.wikiJobLoop()
	return m, nil
}
func validateLimits(l Limits) error {
	if (l.Concurrency < 1 || l.Concurrency > 4) || l.QueueCapacity < 1 || l.MaxSteps < 1 || l.MaxSteps > 16 || l.InputBytes < 1 || l.InputBytes > 65536 || l.CallTimeoutSeconds < 1 || l.RunTimeoutSeconds < 1 || l.ResultBytes < 2 || l.ResultBytes > 262144 || l.RunResultBytes < 2 || l.LogBytes < 1 || l.FrameBytes != 524288 || l.RetentionDays < 1 || l.CancelGraceSeconds < 1 {
		return errors.New("任务运行限额无效，并发须为 1 到 4 且输入输出必须有界")
	}
	return nil
}
func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("系统随机源不可用")
	}
	return hex.EncodeToString(b[:])
}
func (m *Manager) signal() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
func allowed(name string) bool {
	switch name {
	case "docker_containers_list", "docker_images_list", "docker_policy_view", "docker_self_container":
		return true
	}
	return false
}

var requestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func (m *Manager) normalize(input SubmitInput) (SubmitInput, string, error) {
	if !requestPattern.MatchString(input.RequestID) {
		return input, "", bad("invalid-request-id", "请求标识必须为 1 到 128 位字母、数字或 ._:-")
	}
	if input.Kind != "tool-batch" {
		return input, "", bad("invalid-kind", "只支持 tool-batch 顺序工具任务")
	}
	if len(input.Steps) < 1 || len(input.Steps) > m.deps.Limits.MaxSteps {
		return input, "", bad("invalid-steps", "任务步骤数必须在允许范围内")
	}
	// 先复制，后规范化；调用者不能改写已接受的输入快照。
	b, err := json.Marshal(input)
	if err != nil {
		return input, "", bad("invalid-input", "任务参数必须是 JSON 数据")
	}
	if len(b) > m.deps.Limits.InputBytes {
		return input, "", &Error{Status: 413, Code: "input-too-large", Message: "任务请求体过大"}
	}
	var copied SubmitInput
	if err = json.Unmarshal(b, &copied); err != nil {
		return input, "", err
	}
	input = copied
	for i := range input.Steps {
		if input.Steps[i].Args == nil {
			input.Steps[i].Args = map[string]any{}
		}
	}
	// requestId 只作去重键；其余规范化输入组成比较值。
	canonical, err := json.Marshal(struct {
		Kind  string `json:"kind"`
		Steps []Step `json:"steps"`
	}{input.Kind, input.Steps})
	return input, string(canonical), err
}
func (m *Manager) validateSteps(steps []Step) error {
	for _, step := range steps {
		if !allowed(step.Tool) {
			return bad("tool-denied", "任务包含未获准的工具")
		}
		if len(step.Args) != 0 {
			return bad("invalid-arguments", "首版只读工具不接受参数")
		}
	}
	return nil
}
func (m *Manager) availableLocked() error {
	if m.closed {
		return &Error{Status: 503, Code: "runtime-stopped", Message: "任务运行内核已停止"}
	}
	if err := m.store.recordsFault(); err != nil {
		return &Error{Status: 503, Code: "record-storage-unavailable", Message: err.Error()}
	}
	if m.blocked != "" {
		return &Error{Status: 503, Code: "runtime-unavailable", Message: m.blocked}
	}
	if m.workerState != "ready" {
		return &Error{Status: 503, Code: "worker-unavailable", Message: "任务 Worker 尚未就绪"}
	}
	if m.deps.Tools == nil || !m.deps.Tools.Available() {
		return &Error{Status: 503, Code: "tools-unavailable", Message: "只读工具依赖的 Docker 通道不可用"}
	}
	return nil
}
func (m *Manager) Info() RuntimeInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	i := RuntimeInfo{Worker: m.workerState, Storage: "ready", Limits: m.deps.Limits, Tools: []tools.PublicSchema{}}
	if m.storageError || m.store.recordsFault() != nil {
		i.Storage = "unavailable"
	}
	if m.closed {
		i.Storage = "closed"
	}
	if m.deps.Tools != nil {
		for _, schema := range m.deps.Tools.Schemas() {
			if allowed(schema.Name) {
				i.Tools = append(i.Tools, schema)
			}
		}
	}
	if !m.closed {
		if ids, err := m.store.queued(context.Background()); err == nil {
			i.QueueDepth = len(ids)
		} else {
			i.Storage = "unavailable"
		}
	}
	if err := m.availableLocked(); err != nil {
		i.Reason = err.Error()
	} else {
		i.Available = i.Storage == "ready"
	}
	var dispatchError error
	if !m.closed && m.deps.DispatchGuard != nil {
		dispatchError = m.deps.DispatchGuard()
		if dispatchError != nil {
			i.Available, i.Reason = false, dispatchError.Error()
		}
	}
	if recordErr := m.store.recordsFault(); recordErr != nil {
		dispatchError = recordErr
		i.Available, i.Reason = false, recordErr.Error()
	}
	i.Batch = RuntimeCapability{Available: i.Available, Reason: i.Reason}
	i.Workflow.Available = !m.closed && !m.storageError && dispatchError == nil
	if dispatchError != nil {
		i.Workflow.Reason = dispatchError.Error()
	}
	i.Wiki = i.Workflow
	i.WorkflowV2 = i.Workflow
	i.ResourceLocks = i.Workflow
	i.Embedding = RuntimeCapability{Reason: "尚未配置独立 Embedding 服务，本地全文检索可用"}
	if !m.closed {
		profiles, err := m.listEmbeddingProfiles(context.Background())
		if err == nil {
			for _, p := range profiles {
				if p.Active {
					i.Embedding = i.Workflow
					break
				}
			}
		}
	}
	i.Approvals.Available = !m.closed && !m.storageError && dispatchError == nil
	if dispatchError != nil {
		i.Approvals.Reason = dispatchError.Error()
	}
	if e, ok := m.deps.Catalog.(*Extensions); ok {
		i.Skills = extensionAvailability(!m.closed && e.Skills != nil, e.SkillsReason, "技能存储未就绪")
		i.MCP = extensionAvailability(!m.closed && e.Servers != nil && e.MCP != nil, e.MCPReason, "MCP 服务尚未就绪")
		i.Execution = extensionAvailability(!m.closed && e.Executor != nil && e.Config != nil && e.Workspaces != nil, e.ExecutionReason, "容器执行能力尚未就绪")
		i.ExecutionRuntimes = i.Execution
	}
	if err := m.agentAvailableLocked(); err != nil {
		i.Agent.Reason = err.Error()
	} else {
		i.Agent.Available = i.Storage == "ready"
	}
	if dispatchError != nil {
		i.Agent = RuntimeCapability{Reason: dispatchError.Error()}
	}
	return i
}

func extensionAvailability(ready bool, reason, fallback string) RuntimeCapability {
	if reason != "" {
		return RuntimeCapability{Reason: reason}
	}
	if !ready {
		return RuntimeCapability{Reason: fallback}
	}
	return RuntimeCapability{Available: true}
}
func (m *Manager) Submit(ctx context.Context, input SubmitInput) (Run, bool, error) {
	input, canonical, err := m.normalize(input)
	if err != nil {
		return Run{}, false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Run{}, false, &Error{Status: 503, Code: "runtime-stopped", Message: "任务运行内核已停止"}
	}
	r, previous, err := m.store.request(ctx, input.RequestID)
	if err != nil {
		return r, false, storageFailure(err)
	}
	if r.ID != "" {
		if previous != canonical {
			return Run{}, false, &Error{Status: 409, Code: "request-conflict", Message: "请求标识已用于不同的任务输入"}
		}
		return r, true, nil
	}
	if err = m.validateSteps(input.Steps); err != nil {
		return Run{}, false, err
	}
	if err = m.availableLocked(); err != nil {
		return Run{}, false, err
	}
	if err = m.promoteWorkflows(ctx); err != nil {
		return Run{}, false, storageFailure(err)
	}
	queue, err := m.store.queued(ctx)
	if err != nil {
		return Run{}, false, storageFailure(err)
	}
	if len(queue) >= m.deps.Limits.QueueCapacity {
		return Run{}, false, &Error{Status: 429, Code: "queue-full", Message: "任务队列已满，请稍后重试"}
	}
	t := Task{ID: m.deps.NewID(), RequestID: input.RequestID, Kind: input.Kind, DriverVersion: "v1", CreatedAt: stamp(m.deps.Now()), Steps: input.Steps}
	r = Run{RequestID: input.RequestID, RunNumber: 1, ID: m.deps.NewID(), TaskID: t.ID, Status: StateQueued, CreatedAt: t.CreatedAt, Limits: m.deps.Limits, LastSeq: "0"}
	if err = m.store.create(ctx, t, r, canonical); err != nil {
		if ctx.Err() == nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			m.storageFailedLocked()
		}
		return Run{}, false, storageFailure(err)
	}
	r.Task = &t
	r.LastSeq = "1"
	m.signal()
	return r, false, nil
}
func (m *Manager) Get(ctx context.Context, id string) (Run, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Run{}, closedError()
	}
	r, err := m.store.get(ctx, id)
	return r, storageFailure(err)
}
func (m *Manager) List(ctx context.Context, q ListQuery) (Page[Run], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Run]{}, closedError()
	}
	p, err := m.store.list(ctx, q)
	return p, storageFailure(err)
}
func (m *Manager) Calls(ctx context.Context, id, cursor string, limit int) (Page[Call], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Call]{}, closedError()
	}
	p, err := m.store.calls(ctx, id, cursor, limit)
	return p, storageFailure(err)
}
func (m *Manager) Events(ctx context.Context, id, after string, limit int) (Page[Event], error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Page[Event]{}, closedError()
	}
	p, err := m.store.events(ctx, id, after, limit)
	return p, storageFailure(err)
}
func closedError() error {
	return &Error{Status: 503, Code: "runtime-stopped", Message: "任务运行内核已停止"}
}
func (m *Manager) storageFailedLocked() {
	m.storageError = true
	m.blocked = "运行状态写入失败，已停止派发任务"
	for _, execution := range m.executions {
		execution.cancel()
	}
	m.signal()
}

func (m *Manager) Cancel(ctx context.Context, id string) (Run, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Run{}, closedError()
	}
	r, err := m.store.change(ctx, id, "cancel", func(tx *sql.Tx, r *Run) error {
		if terminal(r.Status) || r.CancelRequestedAt != "" {
			return nil
		}
		r.CancelRequestedAt = stamp(m.deps.Now())
		if r.Status == StateQueued || r.Status == StateWaitingApproval || r.Status == StateWaitingResource || r.Status == StateRecoveryRequired {
			r.Status = StateCancelled
			r.EndReason = "cancelled"
			r.EndedAt = r.CancelRequestedAt
		}
		if r.Status == StateCancelled {
			if err := releaseWaitingResourceLeases(ctx, tx, id, r.CancelRequestedAt); err != nil {
				return err
			}
			approvals, err := readApprovalTx(ctx, tx, id)
			if err != nil {
				return err
			}
			for _, a := range approvals {
				if a.Status == "pending" || a.Status == "approved" {
					a.Status = "revoked"
					if err = saveApproval(ctx, tx, a); err != nil {
						return err
					}
				}
			}
		}
		if err := m.store.event(ctx, tx, r, "run/cancel-requested", "", nil, nil); err != nil {
			return err
		}
		if r.Status == StateCancelled {
			return m.store.event(ctx, tx, r, "run/cancelled", "", nil, nil)
		}
		return nil
	})
	if err != nil {
		if _, ok := err.(*Error); !ok && ctx.Err() == nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			m.storageFailedLocked()
		}
		return r, storageFailure(err)
	}
	if execution := m.executionLocked(r.ID); execution != nil && r.CancelRequestedAt != "" {
		execution.cancel()
	}
	m.signal()
	return r, nil
}

func (m *Manager) workerLoop(slot *workerSlot) {
	defer m.closeWorker(slot)
	sweep := time.NewTicker(time.Hour)
	defer sweep.Stop()
	approvalTick := time.NewTicker(time.Minute)
	defer approvalTick.Stop()
	backoff := time.Second
	for {
		if m.ctx.Err() != nil {
			return
		}
		m.mu.Lock()
		blocked := m.blocked != "" || m.store.recordsFault() != nil
		p := slot.process
		m.mu.Unlock()
		if blocked {
			select {
			case <-m.ctx.Done():
				return
			case <-m.wake:
				continue
			}
		}
		if p != nil {
			select {
			case <-processDone(p):
				m.mu.Lock()
				slot.process = nil
				m.setWorkerStateLocked(slot, "unavailable")
				m.mu.Unlock()
				closeCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
				_ = p.Close(closeCtx)
				stop()
				timer := time.NewTimer(time.Second)
				select {
				case <-m.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
				continue
			default:
			}
		}
		// 即使持续有队列，也要在两个任务之间执行到期清理。
		select {
		case <-sweep.C:
			m.mu.Lock()
			if err := m.sweep(m.ctx); err != nil && m.ctx.Err() == nil {
				m.storageFailedLocked()
			}
			m.mu.Unlock()
			continue
		default:
		}
		if p == nil {
			m.mu.Lock()
			m.setWorkerStateLocked(slot, "starting")
			m.mu.Unlock()
			proc, err := m.deps.Spawn(m.ctx)
			if err != nil {
				m.mu.Lock()
				m.setWorkerStateLocked(slot, "unavailable")
				m.mu.Unlock()
				timer := time.NewTimer(backoff)
				select {
				case <-m.ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
				continue
			}
			m.mu.Lock()
			slot.process = proc
			m.setWorkerStateLocked(slot, "ready")
			m.mu.Unlock()
			p = proc
			backoff = time.Second
		}
		m.mu.Lock()
		if m.deps.DispatchGuard != nil && m.deps.DispatchGuard() != nil {
			m.mu.Unlock()
			timer := time.NewTimer(time.Second)
			select {
			case <-m.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}
		if err := m.expireApprovals(m.ctx); err != nil && m.ctx.Err() == nil {
			m.storageFailedLocked()
		}
		if err := m.promoteWorkflows(m.ctx); err != nil {
			m.storageFailedLocked()
		}
		if _, err := m.promoteResourceWaiters(m.ctx); err != nil && m.ctx.Err() == nil {
			m.storageFailedLocked()
		}
		ids, err := m.store.queued(m.ctx)
		if err != nil {
			if m.ctx.Err() == nil {
				m.storageFailedLocked()
			}
			m.mu.Unlock()
			continue
		}
		if len(ids) == 0 {
			m.mu.Unlock()
			select {
			case <-m.ctx.Done():
				return
			case <-m.wake:
			case <-approvalTick.C:
			case <-processDone(p):
			case <-sweep.C:
				m.mu.Lock()
				if err = m.sweep(m.ctx); err != nil && m.ctx.Err() == nil {
					m.storageFailedLocked()
				}
				m.mu.Unlock()
			}
			continue
		}
		var r Run
		for _, id := range ids {
			candidate, readErr := m.store.get(m.ctx, id)
			if readErr != nil {
				err = readErr
				break
			}
			if candidate.WorkflowID != "" {
				w, e := readWorkflow(m.ctx, m.store.db, candidate.WorkflowID)
				if e != nil {
					err = e
					break
				}
				if w.GateClosed || w.Status == StateRecoveryRequired || terminal(w.Status) {
					continue
				}
			}
			if m.rootHasCapacityLocked(candidate) {
				r = candidate
				break
			}
		}
		if err != nil {
			if m.ctx.Err() == nil {
				m.storageFailedLocked()
			}
			m.mu.Unlock()
			continue
		}
		if r.ID == "" {
			m.mu.Unlock()
			select {
			case <-m.ctx.Done():
				return
			case <-m.wake:
			case <-approvalTick.C:
			}
			continue
		}
		if workflowDriver(r) == "agent" {
			_, supported := p.(worker.AgentProcess)
			if !supported {
				err = bad("driver-unavailable", "Worker 不支持单 Agent 循环")
			}
		} else if r.WorkflowID == "" {
			if err = m.validateSteps(r.Task.Steps); err == nil && (r.Task.Kind != "tool-batch" || r.Task.DriverVersion != "v1") {
				err = bad("driver-unavailable", "任务驱动版本不可用")
			}
			if err == nil && (m.deps.Tools == nil || !m.deps.Tools.Available()) {
				err = &Error{Status: 503, Code: "tools-unavailable", Message: "只读工具依赖不可用"}
			}
		}
		if err != nil {
			m.finishLocked(r.ID, StateFailed, "task-unavailable", err.Error())
			m.mu.Unlock()
			continue
		}
		if r.WorkflowID != "" {
			w, e := readWorkflow(m.ctx, m.store.db, r.WorkflowID)
			if e == nil {
				e = m.checkWorkflowEnvironment(m.ctx, w)
			}
			if e != nil {
				m.finishLocked(r.ID, StateFailed, "capability-revoked", "流程固定环境已撤销或无法核验")
				m.mu.Unlock()
				continue
			}
		}
		taskSnapshot := r.Task
		r, err = m.store.change(m.ctx, r.ID, "start", func(tx *sql.Tx, run *Run) error {
			if run.Status != StateQueued {
				return errors.New("任务状态已变化")
			}
			if err := m.workflowReserveTime(m.ctx, tx, run); err != nil {
				return err
			}
			run.Status = StateRunning
			if run.StartedAt == "" {
				run.StartedAt = stamp(m.deps.Now())
			}
			return m.store.event(m.ctx, tx, run, "run/started", "", nil, nil)
		})
		if err != nil {
			if e, ok := err.(*Error); ok {
				m.finishLocked(r.ID, StateFailed, e.Code, e.Message)
			} else if m.ctx.Err() == nil {
				m.storageFailedLocked()
			}
			m.mu.Unlock()
			continue
		}
		r.Task = taskSnapshot
		if m.store.recordsFault() != nil {
			m.finishLocked(r.ID, StateInterrupted, "record-storage-unavailable", "JSONL 记录副本不可用，未启动执行")
			m.mu.Unlock()
			continue
		}
		remaining := time.Duration(r.Limits.RunTimeoutSeconds)*time.Second - time.Duration(r.ActiveMilliseconds)*time.Millisecond
		if r.WorkflowID != "" && time.Duration(r.WorkflowActiveReserved)*time.Millisecond < remaining {
			remaining = time.Duration(r.WorkflowActiveReserved) * time.Millisecond
		}
		runCtx, cancel := context.WithTimeout(m.ctx, remaining)
		activeStart := m.deps.Now()
		execution := &executionState{runID: r.ID, rootID: executionRoot(r), cancel: cancel}
		m.executions[r.ID] = execution
		m.refreshLegacyLocked()
		m.signal()
		m.mu.Unlock()
		if workflowDriver(r) == "agent" {
			agent := &agentExecution{manager: m, run: r}
			m.mu.Lock()
			execution.agent = agent
			m.mu.Unlock()
			err = p.(worker.AgentProcess).RunAgent(runCtx, r.ID, agent)
		} else if r.WorkflowID != "" {
			err = m.executeWorkflowStep(runCtx, r)
		} else {
			steps := make([]worker.Step, len(r.Task.Steps))
			for i, step := range r.Task.Steps {
				args, _ := json.Marshal(step.Args)
				steps[i] = worker.Step{Tool: step.Tool, Args: args}
			}
			err = p.Run(runCtx, r.ID, steps, func(ctx context.Context, index int, name string, args json.RawMessage) (json.RawMessage, error) {
				return m.invoke(ctx, r, index, name, args)
			})
		}
		ctxErr := runCtx.Err()
		cancel()
		// 子进程退出不能证明父工具已退出。先关闭本次运行的新调用入口，再等待
		// 已登记的调用完成持久化或明确报告不协作，才允许释放唯一执行槽。
		m.mu.Lock()
		execution.finishing = true
		m.refreshLegacyLocked()
		callDone := execution.callDone
		m.mu.Unlock()
		if callDone != nil {
			timer := time.NewTimer(time.Duration(r.Limits.CancelGraceSeconds+1) * time.Second)
			select {
			case <-callDone:
				timer.Stop()
			case <-timer.C:
				m.mu.Lock()
				execution.unresponsive = true
				m.blocked = "工具未确认停止，任务派发已暂停，请重启面板后检查"
				m.mu.Unlock()
			}
		}
		// 关闭与挂起同时发生时，真实 Worker 可能优先返回 context.Canceled。
		// 只有父侧调用已完成检查且 Worker 已确认回收，才能依据持久审批边界保留暂停。
		stoppedDuringShutdown := false
		if m.ctx.Err() != nil && err == context.Canceled {
			closeCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			stoppedDuringShutdown = p.Close(closeCtx) == nil
			stop()
			if stoppedDuringShutdown {
				m.mu.Lock()
				slot.process = nil
				m.setWorkerStateLocked(slot, "stopped")
				m.mu.Unlock()
			}
		}
		m.mu.Lock()
		var interrupted *worker.InterruptedError
		if !m.storageError {
			_, e := m.store.change(context.Background(), r.ID, "active-time", func(tx *sql.Tx, current *Run) error {
				elapsed := m.deps.Now().Sub(activeStart)
				if err := m.workflowSettleTime(context.Background(), tx, current, elapsed); err != nil {
					return err
				}
				current.ActiveMilliseconds += elapsed.Milliseconds()
				return saveRun(context.Background(), tx, current)
			})
			if e != nil {
				m.storageFailedLocked()
			}
		}
		if !m.storageError {
			current, getErr := m.store.get(context.Background(), r.ID)
			if getErr != nil {
				m.storageFailedLocked()
			} else {
				state, reason, message := StateSucceeded, "completed", ""
				if (current.Status == StateWaitingApproval || current.Status == StateWaitingResource || current.Status == StateQueued || current.Status == StateRecoveryRequired) && (errors.Is(err, worker.ErrSuspended) || stoppedDuringShutdown) && current.CancelRequestedAt == "" && !execution.unresponsive {
					delete(m.executions, r.ID)
					m.refreshLegacyLocked()
					m.signal()
					m.mu.Unlock()
					continue
				}
				switch {
				case execution.unresponsive:
					state, reason, message = StateInterrupted, "tool-unresponsive", "工具未确认停止，运行结果未确认"
					if current.SessionID != "" {
						reason, message = "operation-unresponsive", "模型或工具未确认停止，运行结果未确认"
					}
				case current.CancelRequestedAt != "":
					state, reason = StateCancelled, "cancelled"
				case m.ctx.Err() != nil:
					state, reason, message = StateInterrupted, "panel-stopped", "面板停止中断了运行，未自动重跑"
				case errors.Is(ctxErr, context.DeadlineExceeded):
					state, reason, message = StateFailed, "run-timeout", "运行超过总时间限制"
				case errors.As(err, &interrupted):
					state, reason, message = StateInterrupted, "worker-lost", "Worker 中断，未自动重跑"
				case err != nil:
					state, reason, message = StateFailed, "tool-failed", "工具执行失败，后续步骤已停止"
					var cause *Error
					if errors.As(err, &cause) {
						reason, message = cause.Code, cause.Message
					}
				}
				m.finishLocked(r.ID, state, reason, message)
			}
		}
		if !execution.unresponsive {
			delete(m.executions, r.ID)
			m.refreshLegacyLocked()
			m.signal()
		}
		// 取消、协议中断与关闭后的进程不复用；工具业务错误可继续下一任务。
		recycle := ctxErr != nil || errors.As(err, &interrupted) || m.blocked != ""
		if recycle {
			slot.process = nil
			m.setWorkerStateLocked(slot, "starting")
		}
		m.mu.Unlock()
		if recycle {
			closeCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			_ = p.Close(closeCtx)
			stop()
		}
	}
}

func processDone(p worker.Process) <-chan struct{} {
	if observed, ok := p.(interface{ Done() <-chan struct{} }); ok {
		return observed.Done()
	}
	return nil
}

func (m *Manager) finishLocked(id, state, reason, message string) {
	ctx := context.Background()
	_, err := m.store.change(ctx, id, "finish", func(tx *sql.Tx, r *Run) error {
		if terminal(r.Status) {
			return nil
		}
		if state == StateSucceeded {
			if r.CancelRequestedAt != "" {
				state, reason = StateCancelled, "cancelled"
			} else if workflowDriver(*r) == "agent" {
				execution := m.executionLocked(r.ID)
				if execution == nil || execution.agent == nil || !execution.agent.finalized {
					state, reason, message = StateInterrupted, "incomplete-run", "Agent 未完成收尾，运行结果未确认"
				}
			} else if r.WorkflowID == "" {
				var count int
				if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM calls WHERE run_id=? AND state='succeeded'", id).Scan(&count); err != nil {
					return err
				}
				var taskJSON string
				if err := tx.QueryRowContext(ctx, "SELECT document FROM tasks WHERE id=?", r.TaskID).Scan(&taskJSON); err != nil {
					return err
				}
				var t Task
				if err := json.Unmarshal([]byte(taskJSON), &t); err != nil {
					return err
				}
				if count != len(t.Steps) {
					state, reason, message = StateInterrupted, "incomplete-run", "Worker 未完成全部步骤，运行结果未确认"
				}
			}
		}
		r.Status = state
		if state == StateCancelled && r.SessionID != "" && r.WorkflowID == "" {
			if err := m.store.saveStoppedReply(ctx, tx, *r); err != nil {
				return err
			}
		}
		if state != StateSucceeded && r.SessionID != "" {
			r.MemoryStatus = "stale"
		}
		if state == StateSucceeded && workflowDriver(*r) == "agent" {
			if err := m.executionLocked(r.ID).agent.commitFinal(ctx, tx, r); err != nil {
				return err
			}
		}
		r.EndReason = reason
		r.EndedAt = stamp(m.deps.Now())
		if err := releaseWaitingResourceLeases(ctx, tx, id, r.EndedAt); err != nil {
			return err
		}
		if message != "" {
			r.Error = &Failure{Code: reason, Message: message}
		}
		if err := interruptCalls(ctx, tx, id, m.deps.Now()); err != nil {
			return err
		}
		return m.store.event(ctx, tx, r, "run/"+state, "", nil, r.Error)
	})
	if err != nil {
		m.storageFailedLocked()
	}
}

// Close 可重复调用；调用者的 deadline 只限制等待，后台清理仍完整进行。
func (m *Manager) Close(ctx context.Context) error {
	m.closeOnce.Do(func() {
		m.mu.Lock()
		m.closed = true
		m.cancel()
		for _, execution := range m.executions {
			execution.cancel()
		}
		m.mu.Unlock()
		go func() {
			<-m.done
			<-m.wikiDone
			m.probes.Wait()
			m.mu.Lock()
			m.closeErr = errors.Join(m.closeErr, m.store.close())
			m.mu.Unlock()
			close(m.closeDone)
		}()
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-m.closeDone:
		return m.closeErr
	}
}
