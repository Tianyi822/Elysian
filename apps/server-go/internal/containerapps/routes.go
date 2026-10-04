package containerapps

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// maxCreateBodyBytes 建工作区与构建请求的 JSON 体上限：远小于读体守卫的缺省值即可。
const maxCreateBodyBytes int64 = 8 * 1024

// buildLogsMaxBytes 构建日志单次响应上限（与 websites 部署日志同档）。
const buildLogsMaxBytes int64 = 64 << 10

// notReadyBuildMsg 引擎不可用时六个构建端点整组 503 的固定文案（与 docker 域
// notReadyPrefix 同句）；文件端点不受影响。
const notReadyBuildMsg = "Docker 服务未就绪"

// AppView 交给界面的工作区视图：登记事实加当场扫出的文件清单。
type AppView struct {
	Slug        string      `json:"slug"`
	DisplayName string      `json:"displayName"`
	CreatedAt   string      `json:"createdAt"`
	Directory   string      `json:"directory"`
	Files       []FileEntry `json:"files"`
}

// createInput 建工作区的请求体。
type createInput struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
}

// contentBody 读文本的响应体。
type contentBody struct {
	Path    string    `json:"path"`
	Content string    `json:"content"`
	File    FileEntry `json:"file"`
}

// Now 注入当前时间，测试可替换。
type Now func() time.Time

// Handler 是挂载用的路由构造器。构建相关字段（ADR-0021）与 websites 片 Deps 同款
// 注入形状：引擎事实由装配层给，EngineAvailable 为假时六个构建端点整组 503。
type Handler struct {
	Registry *Registry
	Time     Now
	// EngineAvailable 容器片就绪事实（docker.Stack.Ready）。
	EngineAvailable bool
	// Engine Engine API 传输器（构建预览的占用回查用）。
	Engine seam.DockerTransport
	// Policy 镜像源校验（docker 域 CheckRegistryHost 注入）。
	Policy func(ctx context.Context, host string) error
	// Logs 操作日志接缝（提交与取消构建记审计）。
	Logs seam.Logs
	// Builds 构建任务机；nil 视同引擎不可用（装配防御）。
	Builds *BuildManager
}

// Router 构造容器应用工作区的 chi 路由。挂载点 /api/container-apps，
// 与其余域片一样经鉴权中间件（app 装配层在 app 级 requireSession 已覆盖全部 /api/*）。
func (h Handler) Router() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.EndpointErrorHandler)
	r.Use(middleware.SameOriginGuard())

	r.Get("/", h.list)
	r.Post("/", h.create)
	r.Route("/{slug}", func(r chi.Router) {
		r.Delete("/", h.remove)
		r.Get("/files", h.listFiles)
		r.Put("/files", h.uploadFile)
		r.Delete("/files", h.deleteFile)
		r.Get("/content", h.readContent)
		r.Put("/content", h.writeContent)
		r.Get("/compose-check", h.checkCompose)
		r.Post("/builds/preview", h.previewBuild)
		r.Post("/builds", h.submitBuild)
		r.Get("/builds", h.listBuilds)
		r.Get("/builds/{taskId}", h.getBuild)
		r.Get("/builds/{taskId}/logs", h.getBuildLogs)
		r.Post("/builds/{taskId}/cancel", h.cancelBuild)
	})
	return r
}

// buildsReady 判构建端点是否可用：引擎事实 + 传输器 + 任务机三件齐备。
func (h Handler) buildsReady() bool {
	return h.EngineAvailable && h.Engine != nil && h.Builds != nil
}

// view 组装单个工作区的界面视图。
func (h Handler) view(record Record) (AppView, error) {
	dir := WorkspaceDir(h.Registry.MountRoot, record.Slug)
	files, err := ListFiles(dir)
	if err != nil {
		return AppView{}, err
	}
	return AppView{
		Slug:        record.Slug,
		DisplayName: record.DisplayName,
		CreatedAt:   record.CreatedAt,
		Directory:   dir,
		Files:       files,
	}, nil
}

func (h Handler) list(w http.ResponseWriter, r *http.Request) {
	records, err := h.Registry.List()
	if err != nil {
		writeError(w, err)
		return
	}
	apps := make([]AppView, 0, len(records))
	for _, record := range records {
		view, viewErr := h.view(record)
		if viewErr != nil {
			writeError(w, viewErr)
			return
		}
		apps = append(apps, view)
	}
	shared.SendJSON(w, http.StatusOK, map[string]any{"apps": apps})
}

func (h Handler) create(w http.ResponseWriter, r *http.Request) {
	body, err := middleware.ReadJSONBody(w, r, maxCreateBodyBytes)
	if err != nil {
		writeError(w, err)
		return
	}
	raw, err := json.Marshal(body)
	if err != nil {
		writeError(w, err)
		return
	}
	var input createInput
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&input); err != nil {
		writeError(w, shared.InvalidRequest("工作区请求字段无效"))
		return
	}
	now := h.Time
	if now == nil {
		now = time.Now
	}
	record, err := h.Registry.Create(input.Slug, input.DisplayName, now())
	if err != nil {
		writeError(w, err)
		return
	}
	view, err := h.view(record)
	if err != nil {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusCreated, view)
}

func (h Handler) remove(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	// 工作区有进行中的构建任务时拒绝删除：任务还引用着目录里的上下文。
	if h.Builds != nil && h.Builds.HasActive(slug) {
		shared.SendError(w, http.StatusConflict, "工作区有进行中的构建任务，请先取消或等待完成")
		return
	}
	if err := h.Registry.Delete(slug); err != nil {
		writeError(w, err)
		return
	}
	// 删除成功后清残留活跃任务：并发窗口内已开跑的任务直接落 failed 终态并停流，
	// 窗口内更晚创建的任务由打包阶段自然失败，不做联合锁。
	if h.Builds != nil {
		h.Builds.InterruptActive(slug, workspaceDeletedMessage)
	}
	w.WriteHeader(http.StatusNoContent)
}

// workspaceDir 解析 slug 并给出其绝对目录，同时校验 path 参数。
func (h Handler) workspaceDir(r *http.Request) (string, string, error) {
	slug := chi.URLParam(r, "slug")
	if err := ValidateSlug(slug); err != nil {
		return "", "", badRequest(err)
	}
	dir, err := h.Registry.Directory(slug)
	if err != nil {
		return "", "", err
	}
	rel, err := NormalizeRelative(r.URL.Query().Get("path"))
	if err != nil {
		return "", "", badRequest(err)
	}
	return dir, rel, nil
}

func (h Handler) listFiles(w http.ResponseWriter, r *http.Request) {
	record, err := h.Registry.Lookup(chi.URLParam(r, "slug"))
	if err != nil {
		writeError(w, err)
		return
	}
	view, err := h.view(record)
	if err != nil {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, map[string]any{"files": view.Files})
}

func (h Handler) uploadFile(w http.ResponseWriter, r *http.Request) {
	dir, rel, err := h.workspaceDir(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if ContentType(r) != "application/octet-stream" {
		writeError(w, &ContentTypeError{Got: r.Header.Get("Content-Type")})
		return
	}
	limited := http.MaxBytesReader(w, r.Body, maxFileBytes+1)
	entry, err := Upload(dir, rel, limited, r.ContentLength)
	if err != nil {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, entry)
}

func (h Handler) deleteFile(w http.ResponseWriter, r *http.Request) {
	dir, rel, err := h.workspaceDir(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if err = DeleteFile(dir, rel); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h Handler) readContent(w http.ResponseWriter, r *http.Request) {
	dir, rel, err := h.workspaceDir(r)
	if err != nil {
		writeError(w, err)
		return
	}
	content, entry, err := ReadContent(dir, rel)
	if err != nil {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, contentBody{Path: entry.Path, Content: content, File: entry})
}

func (h Handler) writeContent(w http.ResponseWriter, r *http.Request) {
	dir, rel, err := h.workspaceDir(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if ContentType(r) != "text/plain" {
		writeError(w, &TextTypeError{})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxTextBytes+1))
	if err != nil {
		writeError(w, err)
		return
	}
	if int64(len(body)) > maxTextBytes {
		writeError(w, &TooLargeError{Limit: maxTextBytes})
		return
	}
	entry, err := WriteContent(dir, rel, string(body))
	if err != nil {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, entry)
}

func (h Handler) checkCompose(w http.ResponseWriter, r *http.Request) {
	dir, rel, err := h.workspaceDir(r)
	if err != nil {
		writeError(w, err)
		return
	}
	content, _, err := ReadContent(dir, rel)
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := CheckCompose(dir, rel, content)
	if err != nil {
		writeError(w, badRequest(err))
		return
	}
	shared.SendJSON(w, http.StatusOK, result)
}

// badRequest 把输入校验类错误统一成 400，避免用户写错路径却收到 500；带状态码的
// 错误（文件不存在等）原样透传，由 writeError 映射。
func badRequest(err error) error {
	if err == nil {
		return nil
	}
	var invalid *shared.InvalidRequestError
	var fileNotFound *FileNotFoundError
	if errors.As(err, &invalid) || errors.As(err, &fileNotFound) {
		return err
	}
	return shared.InvalidRequest(err.Error())
}

// TextTypeError 内容编辑的 Content-Type 不符；映射 415。
type TextTypeError struct{}

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *TextTypeError) Error() string { return "编辑内容必须以 text/plain 提交" }

// writeError 按错误类型映射响应；未知错误交回 middleware 一律 500，不伪装成 4xx。
func writeError(w http.ResponseWriter, err error) {
	var notFound *NotFoundError
	var fileNotFound *FileNotFoundError
	var exists *AlreadyExistsError
	var tooLarge *TooLargeError
	var contentType *ContentTypeError
	var typeError *TextTypeError
	switch {
	case errors.As(err, &notFound):
		shared.SendError(w, http.StatusNotFound, err.Error())
	case errors.As(err, &fileNotFound):
		shared.SendError(w, http.StatusNotFound, err.Error())
	case errors.As(err, &exists):
		shared.SendError(w, http.StatusConflict, err.Error())
	case errors.As(err, &tooLarge):
		shared.SendError(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.As(err, &contentType):
		shared.SendError(w, http.StatusUnsupportedMediaType, err.Error())
	case errors.As(err, &typeError):
		shared.SendError(w, http.StatusUnsupportedMediaType, err.Error())
	default:
		middleware.WriteError(w, err)
	}
}

// ---------- 镜像构建端点（ADR-0021） ----------

// decodeBuildInput 读并校验构建请求体：DisallowUnknownFields + 两模式互斥字段面，
// 不符一律 400「构建请求字段无效」。
func (h Handler) decodeBuildInput(w http.ResponseWriter, r *http.Request, forSubmit bool) (BuildPlanInput, error) {
	body, err := middleware.ReadJSONBody(w, r, maxCreateBodyBytes)
	if err != nil {
		return BuildPlanInput{}, err
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return BuildPlanInput{}, err
	}
	var input BuildPlanInput
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&input); err != nil {
		return BuildPlanInput{}, buildInputInvalid()
	}
	if err = input.validateBuildInputShape(forSubmit); err != nil {
		return BuildPlanInput{}, err
	}
	return input, nil
}

// buildWorkspaceDir 解析 slug 并给出工作区绝对目录（构建端点专用，不带 path 参数）。
func (h Handler) buildWorkspaceDir(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	slug := chi.URLParam(r, "slug")
	if err := ValidateSlug(slug); err != nil {
		writeError(w, err)
		return "", "", false
	}
	dir, err := h.Registry.Directory(slug)
	if err != nil {
		writeError(w, err)
		return "", "", false
	}
	return dir, slug, true
}

// previewBuild POST /{slug}/builds/preview：构建预览（只读不构建），做引擎镜像占用
// 回查与 FROM 源 DNS 校验。
func (h Handler) previewBuild(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	workspaceDir, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	input, err := h.decodeBuildInput(w, r, false)
	if err != nil {
		writeError(w, err)
		return
	}
	switch input.Mode {
	case buildModeDockerfile:
		preview, err := PreviewDockerfileBuild(r.Context(), h.Engine, workspaceDir, slug, input, h.Policy)
		if err != nil {
			writeError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, preview)
	case buildModeCompose:
		preview, err := PreviewComposeBuild(r.Context(), h.Engine, workspaceDir, slug, input.Compose, h.Policy)
		if err != nil {
			writeError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, preview)
	default:
		writeError(w, buildInputInvalid())
	}
}

// submitBuild POST /{slug}/builds：提交构建任务（202 + 任务对象；幂等同参返回原任务）。
func (h Handler) submitBuild(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	workspaceDir, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	input, err := h.decodeBuildInput(w, r, true)
	if err != nil {
		writeError(w, err)
		return
	}
	task, _, err := h.Builds.Submit(r.Context(), workspaceDir, slug, input)
	if err != nil {
		h.recordBuildOperation(r, slug, "提交应用镜像构建", http.StatusAccepted, err)
		writeError(w, err)
		return
	}
	h.recordBuildOperation(r, slug, "提交应用镜像构建", http.StatusAccepted, nil)
	shared.SendJSON(w, http.StatusAccepted, task)
}

// listBuilds GET /{slug}/builds：按创建时间倒序列出任务（no-store）。
func (h Handler) listBuilds(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	_, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	shared.SendJSON(w, http.StatusOK, map[string]any{"builds": h.Builds.List(slug)})
}

// getBuild GET /{slug}/builds/{taskId}：单任务（no-store）。
func (h Handler) getBuild(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	_, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	task, err := h.Builds.Get(slug, chi.URLParam(r, "taskId"))
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	shared.SendJSON(w, http.StatusOK, task)
}

// getBuildLogs GET /{slug}/builds/{taskId}/logs?offset=0：分页日志（与 websites 部署
// 日志同形状：lines/next/total，单次最多 64 KiB）。
func (h Handler) getBuildLogs(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	_, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	taskID := chi.URLParam(r, "taskId")
	if _, err := h.Builds.Get(slug, taskID); err != nil {
		writeError(w, err)
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset < 0 {
		shared.SendError(w, http.StatusBadRequest, "日志偏移无效")
		return
	}
	file, err := os.Open(h.Builds.LogPath(taskID))
	lines := []string{}
	next, total := offset, int64(0)
	if err == nil {
		defer file.Close()
		info, statErr := file.Stat()
		if statErr != nil {
			writeError(w, statErr)
			return
		}
		total = info.Size()
		if offset > total {
			offset = total
		}
		next = offset
		if _, err = file.Seek(offset, 0); err != nil {
			writeError(w, err)
			return
		}
		reader := bufio.NewReader(io.LimitReader(file, buildLogsMaxBytes))
		lastRaw := ""
		windowRead := int64(0)
		sawNewline := false
		for {
			line, readErr := reader.ReadString('\n')
			if line != "" {
				// 行内容剥掉行尾换行再入列表（next 仍按原始字节累加），对齐 mock 侧
				// 按最后换行切分的口径。
				lines = append(lines, strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"))
				next += int64(len(line))
				windowRead += int64(len(line))
				lastRaw = line
				if strings.HasSuffix(line, "\n") {
					sawNewline = true
				}
			}
			if readErr != nil {
				break
			}
		}
		// 半行退回的三种形态分口径处理（与 mock 侧 getAppBuildLogs 的 lastNewline<0
		// 分支同口径）：
		//   窗口内出现过换行、末行被截在中间 → 退回该半行，next 回行首，下次重读；
		//   窗口内一个换行都没有且读满窗口（单行超过 64 KiB，log() 单行上限 128 KiB
		//   允许发生）→ 照样下发该段并把 next 推进到窗口尾，否则 next 永不前进、
		//   分页死循环；
		//   文件尾部尚未收换行的半行（未读满窗口即 EOF）→ 退回等待任务补齐换行。
		if lastRaw != "" && !strings.HasSuffix(lastRaw, "\n") {
			if sawNewline || windowRead < buildLogsMaxBytes {
				lines = lines[:len(lines)-1]
				next -= int64(len(lastRaw))
			}
		}
	} else if !os.IsNotExist(err) {
		writeError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, map[string]any{"lines": lines, "next": next, "total": total})
}

// cancelBuild POST /{slug}/builds/{taskId}/cancel：取消活跃任务（排队中直接终态，
// 构建中取消引擎流）。
func (h Handler) cancelBuild(w http.ResponseWriter, r *http.Request) {
	if !h.buildsReady() {
		shared.SendError(w, http.StatusServiceUnavailable, notReadyBuildMsg)
		return
	}
	_, slug, ok := h.buildWorkspaceDir(w, r)
	if !ok {
		return
	}
	taskID := chi.URLParam(r, "taskId")
	if err := h.Builds.Cancel(slug, taskID); err != nil {
		h.recordBuildOperation(r, slug, "取消应用镜像构建", http.StatusAccepted, err)
		writeError(w, err)
		return
	}
	h.recordBuildOperation(r, slug, "取消应用镜像构建", http.StatusAccepted, nil)
	shared.SendJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

// recordBuildOperation 提交/取消构建的操作审计（Category containers，Result 随错误
// 有无定 success/failure；对齐 docker 终端先例）。
func (h Handler) recordBuildOperation(r *http.Request, slug, action string, successStatus int, failure error) {
	if h.Logs == nil {
		return
	}
	status := successStatus
	result := "success"
	if failure != nil {
		result = "failure"
		var invalid *shared.InvalidRequestError
		var guard *shared.EndpointGuardError
		switch {
		case errors.As(failure, &invalid):
			status = invalid.Status
		case errors.As(failure, &guard):
			status = guard.Status
		default:
			status = http.StatusInternalServerError
		}
	}
	target := slug
	h.Logs.RecordOperation(seam.OperationRecord{
		Category:   "containers",
		Action:     action,
		Target:     &target,
		Result:     result,
		Method:     r.Method,
		Path:       r.URL.Path,
		HTTPStatus: &status,
	})
}
