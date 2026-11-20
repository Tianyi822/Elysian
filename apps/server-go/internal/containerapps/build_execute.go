package containerapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"elysian/server/internal/seam"
)

// buildTagPattern 产物 tag 的钉死形状。
var buildTagPattern = regexp.MustCompile(`^\d{8}-\d{6}-[0-9a-f]{4}$`)

// buildTagFor 拼产物 tag：UTC yyyyMMdd-HHmmss + 任务 id 前 4 字符（时间取注入时钟）。
func buildTagFor(now time.Time, taskID string) string {
	return now.UTC().Format("20060102-150405") + "-" + taskID[:4]
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
	return fmt.Sprintf("构建超时（%s）", formatDurationLimit(m.limits.ImageTimeout))
}

// taskTimeoutError 整任务超时的任务内文案（按注入时限渲染）。
func (m *BuildManager) taskTimeoutError() string {
	return fmt.Sprintf("构建任务超时（%s）", formatDurationLimit(m.limits.TaskTimeout))
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
	if task, ok := m.snapshotTask(taskID); ok && task.Input.ExpectedDigest != "" {
		digest, digestErr := WorkspaceDigest(workspaceDir)
		if digestErr != nil || digest != task.Input.ExpectedDigest {
			_ = os.Remove(tarPath)
			return fail("工作区内容已变化，未派发未经审批的构建上下文")
		}
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
		ExpectedDigest: archive.ExpectedDigest,
		Mode:           archive.Mode,
		RequestID:      archive.RequestID,
		Target:         archive.Target,
		Dockerfile:     archive.Dockerfile,
		Context:        archive.Context,
		Compose:        archive.Compose,
		Services:       archive.Services,
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
	if message := m.contextCause(parent, taskCtx); message != "" {
		return "", errors.New(message)
	}
	blocked := false
	if err = m.mutate(taskID, func(t *BuildTask) {
		for otherID, other := range m.tasks {
			if otherID != taskID && other.MayStillRun && !activeBuild(other.State) {
				blocked = true
				return
			}
		}
		t.MayStillRun, t.DispatchStatus = true, buildDispatchStarted
	}); err != nil {
		return "", err
	}
	if blocked {
		return "", errors.New(buildStageUnconfirmed)
	}
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
	if err = m.mutate(taskID, func(t *BuildTask) {
		t.MayStillRun, t.DispatchStatus = false, buildDispatchFinished
	}); err != nil {
		return "", err
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
