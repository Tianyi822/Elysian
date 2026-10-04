package containerapps

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// maxCreateBodyBytes 建工作区的 JSON 体上限：远小于读体守卫的缺省值即可。
const maxCreateBodyBytes int64 = 8 * 1024

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

// Handler 是挂载用的路由构造器。
type Handler struct {
	Registry *Registry
	Time     Now
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
	})
	return r
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
	if err := h.Registry.Delete(chi.URLParam(r, "slug")); err != nil {
		writeError(w, err)
		return
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

// badRequest 把输入校验类错误统一成 400，避免用户写错路径却收到 500。
func badRequest(err error) error {
	if err == nil {
		return nil
	}
	var invalid *shared.InvalidRequestError
	if errors.As(err, &invalid) {
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
