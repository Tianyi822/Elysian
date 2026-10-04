package containerapps

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
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

	buildErrCancelled = "构建已取消"
	buildErrNoImage   = "构建完成但未找到产物镜像"
	// workspaceDeletedMessage 删除工作区后中断残留任务的固定中文句。
	workspaceDeletedMessage = "工作区已被删除，任务中止"
	buildLogTruncated       = "构建输出已截断，结果以任务终态为准"

	// defaultBuildLogBytes 任务日志总量上限缺省值（ELYSIAN_APP_BUILD_LOG_BYTES 覆盖）。
	defaultBuildLogBytes int64 = 2 << 20
)

// buildIDPattern 任务与请求标识的 uuid 形状（同 websites safeDeploymentID 语义）。
var buildIDPattern = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// buildTagPattern 产物 tag 的钉死形状。
var buildTagPattern = regexp.MustCompile(`^\d{8}-\d{6}-[0-9a-f]{4}$`)

// randomBuildID 生成 uuid 形状任务标识。
func randomBuildID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败属进程级故障：panic 优于写出可预测的标识。
		panic(fmt.Sprintf("系统随机源不可用：%v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func safeBuildID(id string) bool { return buildIDPattern.MatchString(id) }

// buildTagFor 拼产物 tag：UTC yyyyMMdd-HHmmss + 任务 id 前 4 字符（时间取注入时钟）。
func buildTagFor(now time.Time, taskID string) string {
	return now.UTC().Format("20060102-150405") + "-" + taskID[:4]
}

// activeBuild 判任务是否仍在进行（queued|building）。
func activeBuild(state string) bool {
	return state == BuildStateQueued || state == BuildStateBuilding
}

// formatDurationLimit 限额时长的中文渲染：整分钟显示「N 分钟」，不足一分钟显示
// 「N 秒」。缺省 1200s/3600s 渲染为「20 分钟」「60 分钟」，与 ADR-0021 引用的缺省
// 值逐字一致；环境变量覆盖后终态文案随事实变化。
func formatDurationLimit(d time.Duration) string {
	if d >= time.Minute && d%time.Minute == 0 {
		return fmt.Sprintf("%d 分钟", int(d/time.Minute))
	}
	return fmt.Sprintf("%d 秒", int(d/time.Second))
}

// imageTimeoutError 单镜像超时的任务内文案（按注入时限渲染）。
func (m *BuildManager) imageTimeoutError() string {
	return fmt.Sprintf("构建超时（%s），已中止", formatDurationLimit(m.limits.ImageTimeout))
}

// taskTimeoutError 整任务超时的任务内文案（按注入时限渲染）。
func (m *BuildManager) taskTimeoutError() string {
	return fmt.Sprintf("构建任务超时（%s），已中止", formatDurationLimit(m.limits.TaskTimeout))
}

// BuildTaskInput 原样存档的提交请求体（preview 校验通过后的规范化形态）。
type BuildTaskInput struct {
	Mode       string   `json:"mode"`
	RequestID  string   `json:"requestId"`
	Target     string   `json:"target,omitempty"`
	Dockerfile string   `json:"dockerfile,omitempty"`
	Context    string   `json:"context,omitempty"`
	Compose    string   `json:"compose,omitempty"`
	Services   []string `json:"services,omitempty"`
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
	ID        string         `json:"id"`
	Slug      string         `json:"slug"`
	Mode      string         `json:"mode"`
	RequestID string         `json:"requestId"`
	State     string         `json:"state"`
	Stage     string         `json:"stage"`
	CreatedAt string         `json:"createdAt"`
	UpdatedAt string         `json:"updatedAt"`
	Input     BuildTaskInput `json:"input"`
	Results   []BuildResult  `json:"results"`
	Error     string         `json:"error"`
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
}

// buildLogTracker 单任务日志写入记账（总量截断用）。
type buildLogTracker struct {
	written   int64
	truncated bool
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
		deps.NewID = randomBuildID
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
	}
	for _, dir := range []string{deps.StateRoot, deps.LogRoot, deps.SpoolRoot} {
		_ = os.MkdirAll(dir, 0700)
	}
	// 启动恢复：glob 任务 JSON，活跃状态一律改 interrupted 并清 spool（不自动重跑，
	// 重试只经用户显式提交新任务）。
	files, _ := filepath.Glob(filepath.Join(deps.StateRoot, "*.json"))
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var task BuildTask
		if json.Unmarshal(raw, &task) != nil || !safeBuildID(task.ID) {
			continue
		}
		if activeBuild(task.State) {
			task.State = BuildStateInterrupted
			task.Stage = buildStageInterrupted
			task.Error = buildStageInterrupted
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
	go func() {
		for range time.NewTicker(time.Hour).C {
			m.cleanupExpired()
		}
	}()
	return m
}

// now 取注入时钟的当前时间。
func (m *BuildManager) now() time.Time { return m.deps.Now() }

// taskPath 任务 JSON 路径。
func (m *BuildManager) taskPath(taskID string) string {
	return filepath.Join(m.deps.StateRoot, taskID+".json")
}

// LogPath 任务日志路径（日志端点读文件用）。
func (m *BuildManager) LogPath(taskID string) string {
	return filepath.Join(m.deps.LogRoot, taskID+".log")
}

// cleanupExpired 清理 30 天前的终态任务（JSON、日志与 spool 一并删除）。
func (m *BuildManager) cleanupExpired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.now()
	for id, task := range m.tasks {
		if activeBuild(task.State) {
			continue
		}
		created, err := time.Parse(time.RFC3339, task.CreatedAt)
		if err != nil || created.Add(30*24*time.Hour).After(current) {
			continue
		}
		delete(m.tasks, id)
		if task.RequestID != "" && m.requestIndex[task.RequestID] == id {
			delete(m.requestIndex, task.RequestID)
		}
		_ = os.Remove(m.taskPath(id))
		_ = os.Remove(m.LogPath(id))
		_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, id))
		delete(m.logTrackers, id)
	}
}

// log 写一行任务日志：单行截 128 KiB，总量超限后丢弃后续行并只记一次截断提示。
func (m *BuildManager) log(taskID, text string) {
	if len(text) > 128*1024 {
		text = text[:128*1024]
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	tracker := m.logTrackers[taskID]
	if tracker == nil {
		tracker = &buildLogTracker{}
		m.logTrackers[taskID] = tracker
	}
	if tracker.truncated {
		return
	}
	line := text + "\n"
	if tracker.written+int64(len(line)) > m.limits.LogBytes {
		notice := buildLogTruncated + "\n"
		if tracker.written+int64(len(notice)) <= m.limits.LogBytes {
			m.appendLog(taskID, notice)
			tracker.written += int64(len(notice))
		}
		tracker.truncated = true
		return
	}
	m.appendLog(taskID, line)
	tracker.written += int64(len(line))
}

// appendLog 追加写日志文件（调用方持锁）。
func (m *BuildManager) appendLog(taskID, text string) {
	file, err := os.OpenFile(m.LogPath(taskID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	_, _ = io.WriteString(file, text)
	_ = file.Close()
}

// mutate 拷贝、改、落盘、替换（状态逐变化落盘；Results 深拷贝防共享底座）。
func (m *BuildManager) mutate(taskID string, fn func(*BuildTask)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	task := m.tasks[taskID]
	if task == nil {
		return errors.New("构建任务不存在：" + taskID)
	}
	updated := *task
	updated.Results = append([]BuildResult(nil), task.Results...)
	fn(&updated)
	updated.UpdatedAt = m.now().UTC().Format(time.RFC3339)
	if err := config.AtomicJSON(m.taskPath(taskID), &updated); err != nil {
		return err
	}
	m.tasks[taskID] = &updated
	return nil
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
		if task.Slug == slug && activeBuild(task.State) {
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
		return BuildTask{}, &shared.InvalidRequestError{Status: http.StatusNotFound, Message: "构建任务不存在：" + taskID}
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
			Mode:       buildModeDockerfile,
			RequestID:  input.RequestID,
			Target:     plan.Target,
			Dockerfile: plan.DockerfileRel,
			Context:    plan.ContextRel,
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
			Mode:      buildModeCompose,
			RequestID: input.RequestID,
			Compose:   input.Compose,
			Services:  services,
		}
		return plans, archive, nil
	default:
		return nil, BuildTaskInput{}, buildInputInvalid()
	}
}

// Submit 提交构建任务：幂等（requestId 同参返回原任务）、互斥（同工作区活跃唯一）、
// 占用回查（非面板镜像占仓即拒）通过后建 queued 任务并派发 worker。
func (m *BuildManager) Submit(ctx context.Context, workspaceDir, slug string, input BuildPlanInput) (BuildTask, bool, error) {
	if !safeBuildID(input.RequestID) {
		return BuildTask{}, false, shared.InvalidRequest("请求标识无效")
	}
	plans, archive, err := m.resolvePlansForInput(ctx, workspaceDir, slug, input)
	if err != nil {
		return BuildTask{}, false, err
	}
	archiveJSON, err := json.Marshal(archive)
	if err != nil {
		return BuildTask{}, false, err
	}
	m.mu.Lock()
	if existingID, ok := m.requestIndex[input.RequestID]; ok {
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
		if task.Slug == slug && activeBuild(task.State) {
			m.mu.Unlock()
			return BuildTask{}, false, &shared.InvalidRequestError{Status: http.StatusConflict, Message: "工作区已有进行中的构建任务"}
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
			return BuildTask{}, false, &shared.InvalidRequestError{Status: http.StatusConflict, Message: fmt.Sprintf("镜像 %s 已被非面板构建的镜像占用，请换一个目标名或先删除该镜像", plan.Repository)}
		}
	}
	now := m.now()
	taskID := m.deps.NewID()
	task := BuildTask{
		ID:        taskID,
		Slug:      slug,
		Mode:      input.Mode,
		RequestID: input.RequestID,
		State:     BuildStateQueued,
		Stage:     buildStageQueued,
		CreatedAt: now.UTC().Format(time.RFC3339),
		UpdatedAt: now.UTC().Format(time.RFC3339),
		Input:     archive,
		Results:   []BuildResult{},
	}
	parent, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	// 无锁引擎往返（占用回查）期间可能有并发提交插队：插入登记前在锁内重查两不变量，
	// 破坏时直接返回，不插入任何登记（不把引擎往返搬进锁内，避免持锁做 IO）。
	if existingID, ok := m.requestIndex[input.RequestID]; ok {
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
		if existing.Slug == slug && activeBuild(existing.State) {
			m.mu.Unlock()
			cancel()
			return BuildTask{}, false, &shared.InvalidRequestError{Status: http.StatusConflict, Message: "工作区已有进行中的构建任务"}
		}
	}
	if _, exists := m.tasks[taskID]; exists {
		m.mu.Unlock()
		cancel()
		return BuildTask{}, false, errors.New("任务标识冲突，请重试")
	}
	m.tasks[taskID] = &task
	m.requestIndex[input.RequestID] = taskID
	m.cancel[taskID] = cancel
	err = config.AtomicJSON(m.taskPath(taskID), &task)
	if err != nil {
		// 落盘失败在持锁段内回滚内存登记：否则 queued 残留会让 HasActive 恒真、
		// DELETE 与后续 Submit 恒 409 且 worker 从未启动，只能重启解脱。
		delete(m.tasks, taskID)
		if m.requestIndex[input.RequestID] == taskID {
			delete(m.requestIndex, input.RequestID)
		}
		delete(m.cancel, taskID)
		m.mu.Unlock()
		cancel()
		return BuildTask{}, false, err
	}
	m.mu.Unlock()
	m.log(taskID, fmt.Sprintf("已提交构建任务：%s（requestId %s）", taskID, input.RequestID))
	go m.run(parent, taskID)
	copied := task
	copied.Results = []BuildResult{}
	return copied, false, nil
}

// InterruptActive 把工作区全部活跃任务落 failed 终态并取消其 context（删除工作区
// 后的残留清理，固定中文句见 workspaceDeletedMessage）。窗口内更晚创建的任务不做
// 联合锁，由打包阶段的 statBuildContext 自然失败收场。
func (m *BuildManager) InterruptActive(slug, message string) {
	m.mu.Lock()
	type pending struct {
		id     string
		cancel context.CancelFunc
	}
	interrupted := []pending{}
	for id, task := range m.tasks {
		if task.Slug != slug || !activeBuild(task.State) {
			continue
		}
		updated := *task
		updated.Results = append([]BuildResult(nil), task.Results...)
		updated.State = BuildStateFailed
		updated.Stage = buildStageFailed
		updated.Error = message
		updated.UpdatedAt = m.now().UTC().Format(time.RFC3339)
		if err := config.AtomicJSON(m.taskPath(id), &updated); err == nil {
			m.tasks[id] = &updated
		}
		if cancel := m.cancel[id]; cancel != nil {
			interrupted = append(interrupted, pending{id: id, cancel: cancel})
		}
	}
	m.mu.Unlock()
	for _, item := range interrupted {
		_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, item.id))
		item.cancel()
	}
}

// Cancel 取消任务：排队中直接终态，构建中取消引擎流；已终态 409。
func (m *BuildManager) Cancel(slug, taskID string) error {
	m.mu.Lock()
	task := m.tasks[taskID]
	cancel := m.cancel[taskID]
	m.mu.Unlock()
	if task == nil || task.Slug != slug {
		return &shared.InvalidRequestError{Status: http.StatusNotFound, Message: "构建任务不存在：" + taskID}
	}
	if !activeBuild(task.State) {
		return &shared.InvalidRequestError{Status: http.StatusConflict, Message: "构建已结束，无法取消"}
	}
	if cancel != nil {
		cancel()
	}
	return nil
}

// run 派发 worker：排队等待也计入任务时限，拿不到槽即按排队超时/取消收口。
func (m *BuildManager) run(parent context.Context, taskID string) {
	defer func() {
		m.mu.Lock()
		delete(m.cancel, taskID)
		m.mu.Unlock()
	}()
	taskCtx, cancel := context.WithTimeout(parent, m.limits.TaskTimeout)
	defer cancel()
	select {
	case m.workers <- struct{}{}:
	case <-taskCtx.Done():
		state, stage := BuildStateFailed, buildStageFailed
		message := m.taskTimeoutError()
		if parent.Err() != nil {
			state, stage, message = BuildStateCancelled, buildStageCancelled, buildErrCancelled
		}
		m.finishWith(taskID, state, stage, message)
		return
	}
	defer func() { <-m.workers }()
	m.execute(taskCtx, parent, taskID)
}

// execute 任务主体：逐服务「占用回查 → 打包 → FROM 预检 → 构建 → inspect 回查」，
// 任一服务失败则后续不再构建；全部成功后清理旧镜像再落 succeeded。
func (m *BuildManager) execute(taskCtx, parent context.Context, taskID string) {
	task, ok := m.snapshotTask(taskID)
	if !ok {
		return
	}
	if err := m.mutate(taskID, func(t *BuildTask) { t.State = BuildStateBuilding }); err != nil {
		return
	}
	// Registry 缺失属装配错误：任务 goroutine 里的 nil 解引用会崩掉整个进程，
	// 这里按任务失败收口而不是 panic。
	if m.deps.Registry == nil {
		m.finishWith(taskID, BuildStateFailed, buildStageFailed, "构建任务机未注入工作区登记")
		return
	}
	workspaceDir := WorkspaceDir(m.deps.Registry.MountRoot, task.Slug)
	plans, _, err := m.resolvePlansForInput(taskCtx, workspaceDir, task.Slug, taskInputToPlan(task.Input))
	if err != nil {
		m.finishWith(taskID, BuildStateFailed, buildStageFailed, err.Error())
		return
	}
	tag := buildTagFor(parseTaskTime(task.CreatedAt), taskID)
	failedMessage := ""
	for _, plan := range plans {
		if message := m.buildTarget(taskCtx, parent, taskID, task.Slug, workspaceDir, plan, tag); message != "" {
			failedMessage = message
			break
		}
	}
	if failedMessage == "" {
		// 全部目标成功：清理旧镜像（失败只写日志），再落 succeeded。
		if err = m.mutate(taskID, func(t *BuildTask) { t.Stage = "清理旧镜像" }); err == nil {
			for _, plan := range plans {
				m.collectRepository(taskCtx, taskID, plan.Repository)
			}
			m.finishWith(taskID, BuildStateSucceeded, buildStageSucceeded, "")
			return
		}
		failedMessage = err.Error()
	}
	if failedMessage == buildErrCancelled {
		m.finishWith(taskID, BuildStateCancelled, buildStageCancelled, buildErrCancelled)
		return
	}
	m.finishWith(taskID, BuildStateFailed, buildStageFailed, failedMessage)
}

// buildTarget 构建单个目标；返回空串表示成功，非空为任务失败原因（取消/超时译中文）。
func (m *BuildManager) buildTarget(taskCtx, parent context.Context, taskID, slug, workspaceDir string, plan buildServicePlan, tag string) string {
	result := BuildResult{Target: plan.Target, Repository: plan.Repository, Tag: tag, State: BuildStateFailed}
	fail := func(message string) string {
		result.Error = message
		_ = m.mutate(taskID, func(t *BuildTask) { t.Results = append(t.Results, result) })
		return message
	}
	if message := m.contextCause(parent, taskCtx); message != "" {
		return message
	}
	// 任务开始时占用回查（第二道）。
	occupied, err := m.repositoryOccupied(taskCtx, plan.Repository)
	if err != nil {
		return fail("查询镜像占用失败：" + err.Error())
	}
	if occupied {
		return fail(fmt.Sprintf("镜像 %s 已被非面板构建的镜像占用，请换一个目标名或先删除该镜像", plan.Repository))
	}
	stat, err := statBuildContext(plan.ContextAbs)
	if err != nil {
		return fail("打包构建上下文失败：" + err.Error())
	}
	if stat.files > maxContextFiles {
		return fail("构建上下文文件数超过上限 512 个，已中止")
	}
	if stat.bytes > maxContextBytes {
		return fail("构建上下文超过上限 128 MiB，已中止")
	}
	if message := m.contextCause(parent, taskCtx); message != "" {
		return message
	}
	_ = m.mutate(taskID, func(t *BuildTask) {
		t.Stage = fmt.Sprintf("打包构建上下文（%d 个文件，%d 字节）", stat.files, stat.bytes)
	})
	tarPath := spoolTarPath(m.deps.SpoolRoot, taskID)
	if _, err = writeContextTar(plan.ContextAbs, tarPath); err != nil {
		return fail(err.Error())
	}
	if message := m.contextCause(parent, taskCtx); message != "" {
		_ = os.Remove(tarPath)
		return message
	}
	_ = m.mutate(taskID, func(t *BuildTask) { t.Stage = "校验镜像来源" })
	// 权威 FROM 预检读刚写好的 tar 快照，保证「校验对象 = 送引擎构建对象」：磁盘上的
	// Dockerfile 在打包后可能被改写，读磁盘会让预检与构建对着两份数据。
	tarContent, err := readTarEntry(tarPath, plan.EngineDockerfile)
	if err != nil {
		_ = os.Remove(tarPath)
		return fail("打包构建上下文失败：" + err.Error())
	}
	if _, err = inspectDockerfile(taskCtx, string(tarContent), plan.Args, m.deps.Policy); err != nil {
		_ = os.Remove(tarPath)
		return fail(err.Error())
	}
	if message := m.contextCause(parent, taskCtx); message != "" {
		_ = os.Remove(tarPath)
		return message
	}
	_ = m.mutate(taskID, func(t *BuildTask) { t.Stage = fmt.Sprintf("构建镜像 %s", plan.Repository) })
	imageID, err := m.buildImage(taskCtx, parent, taskID, slug, plan, tag, tarPath)
	_ = os.Remove(tarPath)
	if err != nil {
		return fail(err.Error())
	}
	result.State = BuildStateSucceeded
	result.ImageID = imageID
	_ = m.mutate(taskID, func(t *BuildTask) { t.Results = append(t.Results, result) })
	m.log(taskID, fmt.Sprintf("目标 %s 构建成功：%s:%s（%s）", plan.Target, plan.Repository, tag, imageID))
	return ""
}

// finishWith 终态收口：落终态、删 spool、写终态日志、清 cancel。任务已终态时以
// 首个终态为准不覆盖（删除工作区中断残留任务后，worker 的取消路径属此类竞态）。
func (m *BuildManager) finishWith(taskID, state, stage, message string) {
	m.mu.Lock()
	task := m.tasks[taskID]
	alreadyFinal := task != nil && !activeBuild(task.State)
	m.mu.Unlock()
	if alreadyFinal {
		_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, taskID))
		m.mu.Lock()
		delete(m.cancel, taskID)
		m.mu.Unlock()
		return
	}
	_ = m.mutate(taskID, func(t *BuildTask) {
		t.State = state
		t.Stage = stage
		if message != "" {
			t.Error = message
		}
	})
	_ = os.Remove(spoolTarPath(m.deps.SpoolRoot, taskID))
	if message != "" {
		m.log(taskID, "任务终态："+state+"："+message)
	} else {
		m.log(taskID, "任务终态："+state)
	}
	m.mu.Lock()
	delete(m.cancel, taskID)
	m.mu.Unlock()
}

// contextCause 把 ctx 的取消/超时译成任务内中文；空串表示非 ctx 原因。
// 归类次序：用户取消（parent 已取消）→ 整任务超时（taskCtx 超时，文案按注入时限渲染）。
func (m *BuildManager) contextCause(parent, taskCtx context.Context) string {
	if parent.Err() != nil {
		return buildErrCancelled
	}
	if taskCtx != nil && errors.Is(taskCtx.Err(), context.DeadlineExceeded) {
		return m.taskTimeoutError()
	}
	return ""
}

// parseTaskTime 解析任务创建时间（tag 由它派生，保证与提交时刻一致）。
func parseTaskTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}

// taskInputToPlan 把存档输入还原成解析入参。
func taskInputToPlan(archive BuildTaskInput) BuildPlanInput {
	return BuildPlanInput{
		Mode:       archive.Mode,
		RequestID:  archive.RequestID,
		Target:     archive.Target,
		Dockerfile: archive.Dockerfile,
		Context:    archive.Context,
		Compose:    archive.Compose,
		Services:   archive.Services,
	}
}

// repositoryOccupied 回查仓库是否被非面板镜像占用（任一命中缺管理标签即占用）。
func (m *BuildManager) repositoryOccupied(ctx context.Context, repository string) (bool, error) {
	return repositoryOccupiedVia(ctx, m.deps.Engine, repository)
}

// listRepositoryImages 按 reference 过滤列同仓库镜像。
func (m *BuildManager) listRepositoryImages(ctx context.Context, repository string) ([]engineImageSummary, error) {
	return listRepositoryImagesVia(ctx, m.deps.Engine, repository)
}

// buildImage 调引擎 /build（显式 version=1 钉 classic 构建器）：tar 为体，NDJSON 流式
// 读进度与错误；构建成功后按 repo:tag inspect 回查镜像 ID（classic 无 aux 行，ID 只能
// 回查）。限额 2 GiB 内存 + 2 CPU 经 classic 构建器的 memory/cpuquota/cpuperiod 生效。
func (m *BuildManager) buildImage(taskCtx, parent context.Context, taskID, slug string, plan buildServicePlan, tag, tarPath string) (string, error) {
	file, err := os.Open(tarPath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	query := url.Values{}
	query.Set("version", "1")
	query.Set("dockerfile", plan.EngineDockerfile)
	query.Add("t", plan.Repository+":"+tag)
	query.Add("t", plan.Repository+":latest")
	query.Set("rm", "true")
	query.Set("q", "false")
	labels, _ := json.Marshal(map[string]string{
		managedLabelKey:      "true",
		"elysian.build.slug": slug,
		"elysian.build.task": taskID,
	})
	query.Set("labels", string(labels))
	if len(plan.Args) > 0 {
		buildargs, _ := json.Marshal(plan.Args)
		query.Set("buildargs", string(buildargs))
	}
	query.Set("memory", "2147483648")
	query.Set("cpuquota", "200000")
	query.Set("cpuperiod", "100000")
	if plan.BuildTarget != "" {
		query.Set("target", plan.BuildTarget)
	}
	decoder := newBuildStreamDecoder(func(line string) { m.log(taskID, line) })
	imageCtx, cancel := context.WithTimeout(taskCtx, m.limits.ImageTimeout)
	defer cancel()
	response, err := m.deps.Engine.Stream(imageCtx, seam.EngineRequest{
		Method:      http.MethodPost,
		Path:        "/build",
		Query:       query,
		BodyReader:  file,
		ContentType: "application/x-tar",
		DiscardBody: true,
		MaxBytes:    0,
		Timeout:     m.limits.ImageTimeout,
	}, decoder.onChunk)
	if err != nil {
		return "", m.translateBuildStreamError(parent, taskCtx, imageCtx, err)
	}
	if message := decoder.errorMessage(); message != "" {
		return "", fmt.Errorf("构建失败：%s", message)
	}
	if response.Status != http.StatusOK {
		if message := decoder.tailError(); message != "" {
			return "", fmt.Errorf("构建失败：%s", message)
		}
		return "", fmt.Errorf("Docker 构建请求失败（HTTP %d）", response.Status)
	}
	return m.inspectBuildImage(parent, taskCtx, imageCtx, plan.Repository+":"+tag)
}

// inspectBuildImage 回查产物镜像 ID（404 与缺 Id 都按「未找到产物镜像」失败）。
func (m *BuildManager) inspectBuildImage(parent, taskCtx, imageCtx context.Context, ref string) (string, error) {
	response, err := m.deps.Engine.Request(imageCtx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/images/" + ref + "/json",
		MaxBytes: 4 << 20,
	})
	if err != nil {
		if message := m.contextCause(parent, taskCtx); message != "" {
			return "", errors.New(message)
		}
		return "", fmt.Errorf("构建完成后回查产物镜像失败：%v", err)
	}
	if response.Status == http.StatusNotFound {
		return "", errors.New(buildErrNoImage)
	}
	if response.Status != http.StatusOK {
		return "", fmt.Errorf("构建完成后回查产物镜像失败（HTTP %d）", response.Status)
	}
	var inspect struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(response.Body, &inspect) != nil || inspect.ID == "" {
		return "", errors.New(buildErrNoImage)
	}
	return inspect.ID, nil
}

// translateBuildStreamError 把引擎流错误译成任务内中文（用户取消 → 整任务超时 →
// 单镜像超时 → 通用包装），不透传拉取类措辞；超时文案按注入时限渲染。
func (m *BuildManager) translateBuildStreamError(parent, taskCtx, imageCtx context.Context, err error) error {
	if parent.Err() != nil {
		return errors.New(buildErrCancelled)
	}
	if taskCtx != nil && errors.Is(taskCtx.Err(), context.DeadlineExceeded) {
		return errors.New(m.taskTimeoutError())
	}
	if imageCtx != nil && errors.Is(imageCtx.Err(), context.DeadlineExceeded) {
		return errors.New(m.imageTimeoutError())
	}
	if errors.Is(err, context.Canceled) {
		return errors.New(buildErrCancelled)
	}
	return fmt.Errorf("构建请求失败：%v", err)
}

// collectRepository 旧镜像回收：仅面板管理的（带管理标签）、保留最新 2 个不可变
// tag 与 latest，更早的按引用删除（不带 force）；失败写日志保留，不强制清理。
func (m *BuildManager) collectRepository(ctx context.Context, taskID, repository string) {
	images, err := m.listRepositoryImages(ctx, repository)
	if err != nil {
		m.log(taskID, "清理旧镜像失败："+repository+"："+err.Error())
		return
	}
	tags := []string{}
	for _, image := range images {
		if image.Labels[managedLabelKey] != "true" {
			continue
		}
		for _, ref := range image.RepoTags {
			if !strings.HasPrefix(ref, repository+":") {
				continue
			}
			tag := strings.TrimPrefix(ref, repository+":")
			if tag == "" || tag == "latest" {
				continue
			}
			tags = append(tags, tag)
		}
	}
	sort.Strings(tags)
	keep := 2
	if len(tags) <= keep {
		return
	}
	for _, tag := range tags[:len(tags)-keep] {
		ref := repository + ":" + tag
		response, err := m.deps.Engine.Request(ctx, seam.EngineRequest{
			Method:   http.MethodDelete,
			Path:     "/images/" + ref,
			MaxBytes: 1 << 20,
		})
		if err != nil {
			m.log(taskID, "清理旧镜像失败："+ref+"："+err.Error())
			continue
		}
		if response.Status != http.StatusOK && response.Status != http.StatusNoContent {
			m.log(taskID, fmt.Sprintf("清理旧镜像失败：%s（HTTP %d，镜像可能正在使用，已保留）", ref, response.Status))
		}
	}
}

// ---------- classic 构建流的 NDJSON 解码 ----------

// buildStreamDecoder /build 的 NDJSON 流解码：只认 stream 行（写日志）与 error 行
// （取 errorDetail.message 作失败原因），未知/无法解析的行截 128 KiB 原样入日志；
// 另保留末 128 KiB 原始尾，非 200 时从中提取错误。
type buildStreamDecoder struct {
	onLine    func(line string)
	buffer    []byte
	tail      []byte
	streamErr string
}

// newBuildStreamDecoder 构造解码器；onLine 是日志出口。
func newBuildStreamDecoder(onLine func(line string)) *buildStreamDecoder {
	return &buildStreamDecoder{onLine: onLine}
}

// onChunk 喂入一个原始块：切行、逐行消费、维护原始尾。
func (d *buildStreamDecoder) onChunk(chunk []byte) {
	d.tail = append(d.tail, chunk...)
	if excess := len(d.tail) - 128*1024; excess > 0 {
		d.tail = d.tail[excess:]
	}
	d.buffer = append(d.buffer, chunk...)
	for {
		newline := bytes.IndexByte(d.buffer, '\n')
		if newline == -1 {
			break
		}
		line := string(d.buffer[:newline])
		d.buffer = d.buffer[newline+1:]
		d.consume(line)
	}
	// 单行超 128 KiB 还没等到换行：强制切一段，避免缓冲无限增长。
	if len(d.buffer) > 128*1024 {
		line := string(d.buffer[:128*1024])
		d.buffer = d.buffer[128*1024:]
		d.consume(line)
	}
}

// consume 消费一行 NDJSON。
func (d *buildStreamDecoder) consume(line string) {
	if len(line) > 0 && line[len(line)-1] == '\r' {
		line = line[:len(line)-1]
	}
	var frame struct {
		Stream      string `json:"stream"`
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if err := json.Unmarshal([]byte(line), &frame); err == nil {
		if frame.ErrorDetail != nil && frame.ErrorDetail.Message != "" {
			if d.streamErr == "" {
				d.streamErr = frame.ErrorDetail.Message
			}
			return
		}
		if frame.Error != "" {
			if d.streamErr == "" {
				d.streamErr = frame.Error
			}
			return
		}
		if frame.Stream != "" {
			d.onLine(strings.TrimRight(frame.Stream, "\n"))
			return
		}
		// 无已知字段（classic 不出 aux；空行也在此）——原样入日志。
	}
	d.onLine(line)
}

// errorMessage 流内 error 行提取的失败原因（首个）。
func (d *buildStreamDecoder) errorMessage() string { return d.streamErr }

// tailError 从末 128 KiB 原始尾提取 errorDetail.message（非 200 时用）。
func (d *buildStreamDecoder) tailError() string {
	text := d.tail
	for {
		newline := bytes.IndexByte(text, '\n')
		var line []byte
		if newline == -1 {
			line = text
			text = nil
		} else {
			line = text[:newline]
			text = text[newline+1:]
		}
		if message := buildLineErrorMessage(line); message != "" {
			return message
		}
		if newline == -1 {
			return ""
		}
	}
}

// buildLineErrorMessage 从单行原始字节提取 errorDetail.message / error。
func buildLineErrorMessage(line []byte) string {
	var frame struct {
		Error       string `json:"error"`
		ErrorDetail *struct {
			Message string `json:"message"`
		} `json:"errorDetail"`
	}
	if json.Unmarshal(line, &frame) != nil {
		return ""
	}
	if frame.ErrorDetail != nil && frame.ErrorDetail.Message != "" {
		return frame.ErrorDetail.Message
	}
	return frame.Error
}
