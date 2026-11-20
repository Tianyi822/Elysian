package containerapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
	"elysian/server/internal/shared/randomid"
	"elysian/server/internal/taskstore"
)

// 容器工作区的镜像构建任务机（ADR-0021）：任务状态机 + worker 通道 + 取消 +
// 中断恢复 + 30 天清理，形状对齐 websites 域的 deploymentManager。任务模型同
// websites 域：202 提交 + 状态轮询 + 分页日志 + 取消 + 重启标 interrupted。
//
// 镜像统一落 elysian/<slug>/<target> 保留命名空间：tag = <UTC yyyyMMdd-HHmmss>-
// <任务 id 前 4 字符>（不可变）+ latest 别名；仓库被非面板镜像占用即拒，绝不覆盖。
// 仅整任务 succeeded 后按「保留最新 2 个不可变 tag + latest」回收更早的旧镜像，
// failed/cancelled/interrupted 不回收，已完成 target 的镜像保留。
//
// 读 env 只发生在这里导出的 production 构造器（NewProductionBuildManager，仅由装配
// 层调用；websites 域 productionDeploymentManager 同一口径），config.Config 不携带
// 这批变量。

// 构建任务的目录名（~/.Elysian 下三类各一处）。
const buildDirName = "container-app-builds"

// 任务状态取值（英文枚举，界面侧配中文标签）。
const (
	BuildStateQueued      = "queued"
	BuildStateBuilding    = "building"
	BuildStateSucceeded   = "succeeded"
	BuildStateFailed      = "failed"
	BuildStateCancelled   = "cancelled"
	BuildStateInterrupted = "interrupted"
)

// 任务内失败与阶段文案（逐字契约）。
const (
	buildStageQueued      = "等待构建资源"
	buildStageSucceeded   = "构建成功"
	buildStageCancelled   = "已取消"
	buildStageInterrupted = "面板重启中断，未自动重新构建"
	buildStageFailed      = "构建失败"
	buildStageUnconfirmed = "构建停止结果未确认，资源保持占用"

	buildDispatchPending  = "not-dispatched"
	buildDispatchStarted  = "dispatched"
	buildDispatchFinished = "finished"

	buildErrCancelled = "构建已取消"
	buildErrNoImage   = "构建完成但未找到产物镜像"
	// workspaceDeletedMessage 删除工作区后中断残留任务的固定中文句。
	workspaceDeletedMessage = "工作区已被删除，任务中止"
	buildLogTruncated       = "构建输出已截断，结果以任务终态为准"

	// defaultBuildLogBytes 任务日志总量上限缺省值（ELYSIAN_APP_BUILD_LOG_BYTES 覆盖）。
	defaultBuildLogBytes int64 = 2 << 20
)

var errBuildTaskTerminal = errors.New("构建任务已结束")

func safeBuildID(id string) bool { return taskstore.ValidUUIDShape(id) }

// activeBuild 判任务是否仍在进行（queued|building）。
func activeBuild(state string) bool {
	return state == BuildStateQueued || state == BuildStateBuilding
}

// A locally interrupted task still holds reservations until stop is confirmed.
func blocksBuild(task *BuildTask) bool {
	return activeBuild(task.State) || task.MayStillRun
}

// BuildTaskInput 原样存档的提交请求体（preview 校验通过后的规范化形态）。
type BuildTaskInput struct {
	ExpectedDigest string   `json:"expectedDigest,omitempty"`
	Mode           string   `json:"mode"`
	RequestID      string   `json:"requestId"`
	Target         string   `json:"target,omitempty"`
	Dockerfile     string   `json:"dockerfile,omitempty"`
	Context        string   `json:"context,omitempty"`
	Compose        string   `json:"compose,omitempty"`
	Services       []string `json:"services,omitempty"`
}

// BuildResult 单个构建目标的产物事实（按构建次序追加）。
type BuildResult struct {
	Target     string `json:"target"`
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	ImageID    string `json:"imageId"`
	State      string `json:"state"`
	Error      string `json:"error"`
}

// BuildTask 构建任务（持久化与响应同形，键序即 JSON 输出序）。
type BuildTask struct {
	ID             string         `json:"id"`
	Slug           string         `json:"slug"`
	Mode           string         `json:"mode"`
	RequestID      string         `json:"requestId"`
	State          string         `json:"state"`
	Stage          string         `json:"stage"`
	CreatedAt      string         `json:"createdAt"`
	UpdatedAt      string         `json:"updatedAt"`
	Input          BuildTaskInput `json:"input"`
	Results        []BuildResult  `json:"results"`
	MayStillRun    bool           `json:"mayStillRun,omitempty"`
	DispatchStatus string         `json:"dispatchStatus,omitempty"`
	Error          string         `json:"error"`
}

// BuildLimits 构建限额（超时、并发与日志保留经环境变量可调，资源配额固定）。
type BuildLimits struct {
	ImageTimeout time.Duration
	TaskTimeout  time.Duration
	Concurrency  int
	LogBytes     int64
}

func defaultBuildLimits() BuildLimits {
	return BuildLimits{ImageTimeout: 1200 * time.Second, TaskTimeout: 3600 * time.Second, Concurrency: 1, LogBytes: defaultBuildLogBytes}
}

// BuildDeps 构建任务机的注入依赖（真实装配与测试替身共用一套形状）。
type BuildDeps struct {
	// Engine Engine API 传输器（HTTP-over-unix；引擎不可用时构建端点整组 503）。
	Engine seam.DockerTransport
	// Policy 镜像源校验（docker 域 CheckRegistryHost 注入）；nil 时非官方 FROM 一律拒绝。
	Policy func(ctx context.Context, host string) error
	// Registry 工作区登记（执行时按 slug 解析工作区绝对目录）。
	Registry *Registry
	// Now 注入时钟（tag 时间与任务时间戳）。
	Now func() time.Time
	// NewID 任务标识生成（测试注入确定性序列）。
	NewID func() string
	// StateRoot 任务 JSON 目录覆盖（缺省 ~/.Elysian/state/container-app-builds）。
	StateRoot string
	// LogRoot 任务日志目录覆盖（缺省 ~/.Elysian/logs/container-app-builds）。
	LogRoot string
	// SpoolRoot 上下文 tar 目录覆盖（缺省 ~/.Elysian/tmp/container-app-builds）。
	SpoolRoot string
}

// BuildManager 镜像构建任务机。
type BuildManager struct {
	mu           sync.Mutex
	deps         BuildDeps
	limits       BuildLimits
	tasks        map[string]*BuildTask
	cancel       map[string]context.CancelFunc
	requestIndex map[string]string
	workers      chan struct{}
	logTrackers  map[string]*buildLogTracker

	cleanupStop chan struct{}
	cleanupDone chan struct{}
	cleanupOnce sync.Once
}

// NewBuildManager 构造任务机：恢复中断任务、清 spool、启动 30 天清理 ticker。
func NewBuildManager(deps BuildDeps) *BuildManager {
	return newBuildManager(deps, defaultBuildLimits())
}

// NewProductionBuildManager 生产构造器：读 ELYSIAN_APP_BUILD_* 四个环境变量
// （缺省 1200/3600/1/2097152；非法值回落缺省），仅由装配层调用。
func NewProductionBuildManager(deps BuildDeps) *BuildManager {
	limits := defaultBuildLimits()
	read := func(key string, current int64) int64 {
		n, err := parseEnvPositiveInt(key)
		if err == nil {
			return n
		}
		return current
	}
	limits.ImageTimeout = time.Duration(read("ELYSIAN_APP_BUILD_TIMEOUT_SECONDS", int64(limits.ImageTimeout/time.Second))) * time.Second
	limits.TaskTimeout = time.Duration(read("ELYSIAN_APP_BUILD_TASK_TIMEOUT_SECONDS", int64(limits.TaskTimeout/time.Second))) * time.Second
	limits.Concurrency = int(read("ELYSIAN_APP_BUILD_CONCURRENCY", int64(limits.Concurrency)))
	limits.LogBytes = read("ELYSIAN_APP_BUILD_LOG_BYTES", limits.LogBytes)
	return newBuildManager(deps, limits)
}

// parseEnvPositiveInt 读一个正整数环境变量（未设置或非正整数都报错）。
func parseEnvPositiveInt(key string) (int64, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return 0, errors.New("未设置")
	}
	var n int64
	if _, err := fmt.Sscanf(value, "%d", &n); err != nil || n <= 0 || fmt.Sprintf("%d", n) != value {
		return 0, errors.New("不是正整数")
	}
	return n, nil
}

func newBuildManager(deps BuildDeps, limits BuildLimits) *BuildManager {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.NewID == nil {
		deps.NewID = randomid.UUIDv4
	}
	if deps.StateRoot == "" {
		deps.StateRoot = filepath.Join(paths.StateDir, buildDirName)
	}
	if deps.LogRoot == "" {
		deps.LogRoot = filepath.Join(paths.LogsDir, buildDirName)
	}
	if deps.SpoolRoot == "" {
		deps.SpoolRoot = filepath.Join(paths.TmpDir, buildDirName)
	}
	if limits.Concurrency < 1 {
		limits.Concurrency = 1
	}
	if limits.LogBytes <= 0 {
		limits.LogBytes = defaultBuildLogBytes
	}
	m := &BuildManager{
		deps:         deps,
		limits:       limits,
		tasks:        map[string]*BuildTask{},
		cancel:       map[string]context.CancelFunc{},
		requestIndex: map[string]string{},
		workers:      make(chan struct{}, limits.Concurrency),
		logTrackers:  map[string]*buildLogTracker{},
		cleanupStop:  make(chan struct{}),
		cleanupDone:  make(chan struct{}),
	}
	for _, dir := range []string{deps.StateRoot, deps.LogRoot, deps.SpoolRoot} {
		_ = os.MkdirAll(dir, 0700)
	}
	// 启动恢复：glob 任务 JSON，活跃状态一律改 interrupted 并清 spool（不自动重跑，
	// 重试只经用户显式提交新任务）。
	files, _ := m.ledger().Glob()
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var task BuildTask
		if json.Unmarshal(raw, &task) != nil || !safeBuildID(task.ID) {
			continue
		}
		// Legacy failures and interrupted builds lack dispatch evidence. Keep their
		// reservations until a trustworthy completion record can establish stop.
		if task.DispatchStatus == "" {
			switch task.State {
			case BuildStateQueued:
				task.DispatchStatus = buildDispatchPending
			case BuildStateBuilding, BuildStateFailed, BuildStateCancelled, BuildStateInterrupted:
				task.DispatchStatus, task.MayStillRun = buildDispatchStarted, true
			}
		}
		if task.DispatchStatus == buildDispatchStarted {
			task.MayStillRun = true
		}
		if activeBuild(task.State) || task.MayStillRun {
			task.State = BuildStateInterrupted
			task.Stage = buildStageInterrupted
			task.Error = buildStageInterrupted
			if task.MayStillRun {
				task.Stage = buildStageUnconfirmed
				task.Error += "；" + buildStageUnconfirmed
			}
			_ = config.AtomicJSON(file, &task)
			_ = os.Remove(spoolTarPath(deps.SpoolRoot, task.ID))
		}
		if task.Results == nil {
			task.Results = []BuildResult{}
		}
		m.tasks[task.ID] = &task
		if task.RequestID != "" && safeBuildID(task.RequestID) {
			m.requestIndex[task.RequestID] = task.ID
		}
	}
	m.cleanupExpired()
	ticker := time.NewTicker(time.Hour)
	go func() {
		defer close(m.cleanupDone)
		defer ticker.Stop()
		for {
			select {
			case <-m.cleanupStop:
				return
			case <-ticker.C:
				m.cleanupExpired()
			}
		}
	}()
	return m
}

// Close 停止并等待定期清理，不更改在途构建。
func (m *BuildManager) Close(ctx context.Context) error {
	m.cleanupOnce.Do(func() { close(m.cleanupStop) })
	select {
	case <-m.cleanupDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// now 取注入时钟的当前时间。
func (m *BuildManager) now() time.Time { return m.deps.Now() }

func (m *BuildManager) ledger() taskstore.Dir { return taskstore.Dir(m.deps.StateRoot) }

// cleanupExpired 清理 30 天前的终态任务（JSON、日志与 spool 一并删除）。
func (m *BuildManager) cleanupExpired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.now()
	for id, task := range m.tasks {
		if blocksBuild(task) {
			continue
		}
		deadline, err := taskstore.RetentionDeadline(task.CreatedAt)
		if err != nil || deadline.After(current) {
			continue
		}
		delete(m.tasks, id)
		if task.RequestID != "" && m.requestIndex[task.RequestID] == id {
			delete(m.requestIndex, task.RequestID)
		}
		_ = m.ledger().Remove(id)
		_ = os.Remove(m.LogPath(id))
		_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, id))
		delete(m.logTrackers, id)
	}
}

// mutate 拷贝、改、落盘、替换（状态逐变化落盘；Results 深拷贝防共享底座）。
func (m *BuildManager) mutate(taskID string, fn func(*BuildTask)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[taskID]
	if task == nil {
		return errors.New("构建任务不存在：" + taskID)
	}
	if !blocksBuild(task) {
		return errBuildTaskTerminal
	}
	updated := *task
	updated.Results = append([]BuildResult(nil), task.Results...)
	fn(&updated)
	updated.UpdatedAt = m.now().UTC().Format(time.RFC3339)
	return taskstore.SaveAndPublish(m.ledger(), m.tasks, taskID, &updated, config.AtomicJSON)
}

// snapshotTask 取任务副本（响应用，不暴露内部指针）。
func (m *BuildManager) snapshotTask(taskID string) (BuildTask, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked(taskID)
}

// snapshotLocked 取任务副本（调用方持锁）。
func (m *BuildManager) snapshotLocked(taskID string) (BuildTask, bool) {
	task := m.tasks[taskID]
	if task == nil {
		return BuildTask{}, false
	}
	copied := *task
	copied.Results = append([]BuildResult(nil), task.Results...)
	return copied, true
}

// HasActive 判工作区是否有进行中的构建任务。
func (m *BuildManager) HasActive(slug string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, task := range m.tasks {
		if task.Slug == slug && blocksBuild(task) {
			return true
		}
	}
	return false
}

// List 按创建时间倒序返回工作区的全部任务。
func (m *BuildManager) List(slug string) []BuildTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := []BuildTask{}
	for _, task := range m.tasks {
		if task.Slug != slug {
			continue
		}
		if copied, ok := m.snapshotLocked(task.ID); ok {
			rows = append(rows, copied)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].CreatedAt != rows[j].CreatedAt {
			return rows[i].CreatedAt > rows[j].CreatedAt
		}
		return rows[i].ID > rows[j].ID
	})
	return rows
}

// Get 取单任务；不存在或归属不符都回 404 文案。
func (m *BuildManager) Get(slug, taskID string) (BuildTask, error) {
	m.mu.Lock()
	task := m.tasks[taskID]
	m.mu.Unlock()
	if task == nil || task.Slug != slug {
		return BuildTask{}, shared.NotFound("构建任务不存在：" + taskID)
	}
	copied := *task
	copied.Results = append([]BuildResult(nil), task.Results...)
	return copied, nil
}

// resolvePlansForInput 按 input 解析构建计划与规范化存档（提交与执行共用）。
func (m *BuildManager) resolvePlansForInput(ctx context.Context, workspaceDir, slug string, input BuildPlanInput) ([]buildServicePlan, BuildTaskInput, error) {
	switch input.Mode {
	case buildModeDockerfile:
		plan, _, err := resolveDockerfilePlan(ctx, workspaceDir, slug, input, m.deps.Policy)
		if err != nil {
			return nil, BuildTaskInput{}, err
		}
		archive := BuildTaskInput{
			ExpectedDigest: input.ExpectedDigest,
			Mode:           buildModeDockerfile,
			RequestID:      input.RequestID,
			Target:         plan.Target,
			Dockerfile:     plan.DockerfileRel,
			Context:        plan.ContextRel,
		}
		return []buildServicePlan{plan}, archive, nil
	case buildModeCompose:
		content, _, err := ReadContent(workspaceDir, input.Compose)
		if err != nil {
			return nil, BuildTaskInput{}, err
		}
		var selected []string
		if len(input.Services) > 0 {
			selected = input.Services
		}
		plans, _, err := resolveComposePlan(ctx, workspaceDir, slug, input.Compose, content, selected, m.deps.Policy)
		if err != nil {
			return nil, BuildTaskInput{}, err
		}
		services := make([]string, 0, len(plans))
		for _, plan := range plans {
			services = append(services, plan.Service)
		}
		archive := BuildTaskInput{
			ExpectedDigest: input.ExpectedDigest,
			Mode:           buildModeCompose,
			RequestID:      input.RequestID,
			Compose:        input.Compose,
			Services:       services,
		}
		return plans, archive, nil
	default:
		return nil, BuildTaskInput{}, buildInputInvalid()
	}
}

// Submit 提交构建任务：幂等（requestId 同参返回原任务）、互斥（同工作区活跃唯一）、
// 占用回查（非面板镜像占仓即拒）通过后建 queued 任务并派发 worker。
func (m *BuildManager) Submit(ctx context.Context, workspaceDir, slug string, input BuildPlanInput) (BuildTask, bool, error) {
	release, lockErr := m.deps.Registry.LockWorkspace(ctx, slug)
	if lockErr != nil {
		return BuildTask{}, false, lockErr
	}
	defer release()
	if input.ExpectedDigest != "" {
		digest, err := WorkspaceDigest(workspaceDir)
		if err != nil {
			return BuildTask{}, false, err
		}
		if digest != input.ExpectedDigest {
			return BuildTask{}, false, shared.Conflict("工作区内容已变化，请重新预览并审批")
		}
	}
	if !safeBuildID(input.RequestID) {
		return BuildTask{}, false, shared.InvalidRequest("请求标识无效")
	}
	plans, archive, err := m.resolvePlansForInput(ctx, workspaceDir, slug, input)
	if err != nil {
		return BuildTask{}, false, err
	}
	return m.validateAndQueue(ctx, slug, plans, archive)
}

// validateAndQueue 在工作区锁内执行；引擎回查不持有任务锁。
func (m *BuildManager) validateAndQueue(ctx context.Context, slug string, plans []buildServicePlan, archive BuildTaskInput) (BuildTask, bool, error) {
	archiveJSON, err := json.Marshal(archive)
	if err != nil {
		return BuildTask{}, false, err
	}
	m.mu.Lock()
	if existingID, ok := m.requestIndex[archive.RequestID]; ok {
		existing, found := m.snapshotLocked(existingID)
		m.mu.Unlock()
		if found {
			existingJSON, marshalErr := json.Marshal(existing.Input)
			if marshalErr == nil && string(existingJSON) == string(archiveJSON) {
				return existing, true, nil
			}
		}
		return BuildTask{}, false, shared.InvalidRequest("请求标识已用于其他构建")
	}
	for _, task := range m.tasks {
		if task.MayStillRun && !activeBuild(task.State) {
			m.mu.Unlock()
			return BuildTask{}, false, shared.Conflict(buildStageUnconfirmed)
		}
		if task.Slug == slug && blocksBuild(task) {
			m.mu.Unlock()
			return BuildTask{}, false, shared.Conflict("工作区已有进行中的构建任务")
		}
	}
	m.mu.Unlock()
	// 提交前占用回查：仓库任一 tag 存在且缺管理标签即拒，绝不覆盖用户镜像。
	for _, plan := range plans {
		occupied, occErr := m.repositoryOccupied(ctx, plan.Repository)
		if occErr != nil {
			return BuildTask{}, false, occErr
		}
		if occupied {
			return BuildTask{}, false, shared.Conflict(fmt.Sprintf("镜像 %s 已被非面板构建的镜像占用，请换一个目标名或先删除该镜像", plan.Repository))
		}
	}
	now := m.now()
	taskID := m.deps.NewID()
	task := BuildTask{
		ID:             taskID,
		Slug:           slug,
		Mode:           archive.Mode,
		RequestID:      archive.RequestID,
		State:          BuildStateQueued,
		Stage:          buildStageQueued,
		CreatedAt:      now.UTC().Format(time.RFC3339),
		UpdatedAt:      now.UTC().Format(time.RFC3339),
		Input:          archive,
		Results:        []BuildResult{},
		DispatchStatus: buildDispatchPending,
	}
	parent, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	// 无锁引擎往返（占用回查）期间可能有并发提交插队：插入登记前在锁内重查两不变量，
	// 破坏时直接返回，不插入任何登记（不把引擎往返搬进锁内，避免持锁做 IO）。
	if existingID, ok := m.requestIndex[archive.RequestID]; ok {
		existing, found := m.snapshotLocked(existingID)
		if found {
			existingJSON, marshalErr := json.Marshal(existing.Input)
			if marshalErr == nil && string(existingJSON) == string(archiveJSON) {
				m.mu.Unlock()
				cancel()
				return existing, true, nil
			}
		}
		m.mu.Unlock()
		cancel()
		return BuildTask{}, false, shared.InvalidRequest("请求标识已用于其他构建")
	}
	for _, existing := range m.tasks {
		if existing.MayStillRun && !activeBuild(existing.State) {
			m.mu.Unlock()
			cancel()
			return BuildTask{}, false, shared.Conflict(buildStageUnconfirmed)
		}
		if existing.Slug == slug && blocksBuild(existing) {
			m.mu.Unlock()
			cancel()
			return BuildTask{}, false, shared.Conflict("工作区已有进行中的构建任务")
		}
	}
	if _, exists := m.tasks[taskID]; exists {
		m.mu.Unlock()
		cancel()
		return BuildTask{}, false, errors.New("任务标识冲突，请重试")
	}
	m.tasks[taskID] = &task
	m.requestIndex[archive.RequestID] = taskID
	m.cancel[taskID] = cancel
	err = config.AtomicJSON(m.ledger().Path(taskID), &task)
	if err != nil {
		// 落盘失败在持锁段内回滚内存登记：否则 queued 残留会让 HasActive 恒真、
		// DELETE 与后续 Submit 恒 409 且 worker 从未启动，只能重启解脱。
		delete(m.tasks, taskID)
		if m.requestIndex[archive.RequestID] == taskID {
			delete(m.requestIndex, archive.RequestID)
		}
		delete(m.cancel, taskID)
		m.mu.Unlock()
		cancel()
		return BuildTask{}, false, err
	}
	m.mu.Unlock()
	m.log(taskID, fmt.Sprintf("已提交构建任务：%s（requestId %s）", taskID, archive.RequestID))
	go m.run(parent, taskID)
	copied := task
	copied.Results = []BuildResult{}
	return copied, false, nil
}

// InterruptActive 取消工作区残留任务；已派发且停止未确认时保留资源屏障。
// 窗口内更晚创建的任务不做
// 联合锁，由打包阶段的 statBuildContext 自然失败收场。
func (m *BuildManager) InterruptActive(slug, message string) {
	m.mu.Lock()
	interrupted := []buildInterruption{}
	for id, task := range m.tasks {
		if task.Slug != slug || !blocksBuild(task) {
			continue
		}
		updated := *task
		updated.Results = append([]BuildResult(nil), task.Results...)
		updated.State = BuildStateFailed
		updated.Stage = buildStageFailed
		updated.Error = message
		if updated.MayStillRun {
			updated.State, updated.Stage = BuildStateInterrupted, buildStageUnconfirmed
			updated.Error += "；" + buildStageUnconfirmed
		}
		updated.UpdatedAt = m.now().UTC().Format(time.RFC3339)
		_ = taskstore.SaveAndPublish(m.ledger(), m.tasks, id, &updated, config.AtomicJSON)
		if cancel := m.cancel[id]; cancel != nil {
			interrupted = append(interrupted, buildInterruption{id: id, cancel: cancel})
		}
	}
	m.mu.Unlock()
	for _, item := range interrupted {
		_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, item.id))
		item.cancel()
	}
}

type buildInterruption struct {
	id     string
	cancel context.CancelFunc
}

// Cancel 取消任务：排队中直接终态，构建中取消引擎流；已终态 409。
func (m *BuildManager) Cancel(slug, taskID string) error {
	m.mu.Lock()
	task := m.tasks[taskID]
	cancel := m.cancel[taskID]
	m.mu.Unlock()
	if task == nil || task.Slug != slug {
		return shared.NotFound("构建任务不存在：" + taskID)
	}
	if !activeBuild(task.State) {
		return shared.Conflict("构建已结束，无法取消")
	}
	if cancel != nil {
		cancel()
	}
	return nil
}

// finishWith 终态收口：落终态、删 spool、写终态日志、清 cancel。任务已终态时以
// 首个终态为准不覆盖（删除工作区中断残留任务后，worker 的取消路径属此类竞态）。
func (m *BuildManager) finishWith(taskID, state, stage, message string) {
	if state == BuildStateFailed && m.deps.Registry != nil {
		// 删除登记持有 Registry.mu，查询会等其完成。worker 可能先于删除方的
		// InterruptActive 观察到文件消失，仍必须保留同一条领域错误文案。
		if task, ok := m.snapshotTask(taskID); ok {
			_, err := m.deps.Registry.Directory(task.Slug)
			var missing *NotFoundError
			if errors.As(err, &missing) {
				message = workspaceDeletedMessage
			}
		}
	}
	// 活跃检查与终态发布由 mutate 在同一把锁内完成；进度回写也不能改终态。
	err := m.mutate(taskID, func(t *BuildTask) {
		t.State = state
		t.Stage = stage
		if message != "" {
			t.Error = message
		}
		if t.MayStillRun {
			t.State, t.Stage = BuildStateInterrupted, buildStageUnconfirmed
			t.Error = message + "；" + buildStageUnconfirmed
		}
	})
	_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, taskID))
	if err == nil {
		if latest, ok := m.snapshotTask(taskID); ok {
			label := "任务终态："
			if latest.MayStillRun {
				label = "任务停止未确认："
			}
			m.log(taskID, label+latest.State+"："+latest.Error)
		}
	}
	m.mu.Lock()
	delete(m.cancel, taskID)
	m.mu.Unlock()
}
