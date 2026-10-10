package harness

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

func registerExtensionRoutes(r chi.Router, service runtimeService) {
	wrap := func(kind string, handler func(*Extensions, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			manager, ok := service.(*Manager)
			if !ok {
				writeRuntimeError(w, &Error{503, "extensions-unavailable", "Agent 扩展能力不可用"})
				return
			}
			manager.mu.Lock()
			closed := manager.closed
			e, ok := manager.deps.Catalog.(*Extensions)
			manager.mu.Unlock()
			if closed {
				writeRuntimeError(w, closedError())
				return
			}
			if !ok || e == nil || kind == "skills" && e.Skills == nil || kind == "mcp" && e.Servers == nil || kind == "execution" && e.Config == nil {
				writeRuntimeError(w, &Error{503, "extensions-unavailable", "所需 Agent 扩展尚未装配"})
				return
			}
			handler(e, w, req)
		}
	}
	r.Get("/skills", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		items, err := e.Skills.List()
		sendExtension(w, 200, items, err)
	}))
	r.Get("/skills/{id}", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		revision, err := extensionRevision(req, false)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Skills.Get(chi.URLParam(req, "id"), revision, true)
		sendExtension(w, 200, item, err)
	}))
	r.Put("/skills/{id}", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readEnabledInput(w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Skills.SetEnabled(chi.URLParam(req, "id"), in.ExpectedRevision, *in.Enabled)
		sendExtension(w, 200, item, err)
	}))
	r.Get("/skills/imports", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		q, err := runtimeQuery(req, 50, "cursor", "limit")
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		page, err := e.Skills.ListImports(q.Cursor, q.Limit)
		sendExtension(w, 200, page, err)
	}))
	r.Post("/skills/imports", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, archive, err := readSkillImport(w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		ctx, cancel := context.WithTimeout(req.Context(), 5*time.Minute)
		defer cancel()
		task, duplicate, err := e.Skills.StartImport(ctx, in, archive)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		status := http.StatusAccepted
		if duplicate {
			status = http.StatusOK
		}
		w.Header().Set("Location", "/api/agent/skills/imports/"+url.PathEscape(task.ID))
		shared.SendJSON(w, status, task)
	}))
	r.Get("/skills/imports/{id}", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		task, err := e.Skills.GetImport(chi.URLParam(req, "id"))
		sendExtension(w, 200, task, err)
	}))
	r.Post("/skills/imports/{id}/cancel", wrap("skills", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		task, err := e.Skills.CancelImport(chi.URLParam(req, "id"))
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		status := http.StatusOK
		if task.State == skills.StateQueued || task.State == skills.StateRunning {
			status = http.StatusAccepted
		}
		shared.SendJSON(w, status, task)
	}))
	r.Get("/mcp-servers", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, e.Servers.List())
	}))
	r.Post("/mcp-servers", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[mcp.Input](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Servers.Create(in)
		sendExtension(w, 201, item, err)
	}))
	r.Get("/mcp-servers/{id}", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		revision, err := extensionRevision(req, true)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Servers.Resolve(chi.URLParam(req, "id"), revision, true)
		sendExtension(w, 200, item.Public(), err)
	}))
	r.Put("/mcp-servers/{id}", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[struct {
			mcp.Input
			ExpectedRevision int `json:"expectedRevision"`
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Servers.Update(chi.URLParam(req, "id"), in.ExpectedRevision, in.Input)
		sendExtension(w, 200, item, err)
	}))
	r.Post("/mcp-servers/{id}/probe", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if e.MCP == nil {
			writeRuntimeError(w, &Error{503, "mcp-unavailable", "MCP 传输通道尚未装配"})
			return
		}
		in, err := readAgentInput[struct {
			Revision int `json:"revision"`
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if in.Revision < 1 {
			writeRuntimeError(w, bad("invalid-revision", "探测必须固定服务修订"))
			return
		}
		id := chi.URLParam(req, "id")
		server, err := e.Servers.Resolve(id, in.Revision, false)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		m := service.(*Manager)
		catalog, err := m.probeServer(req.Context(), e, server)
		sendExtension(w, 200, publicMCPCatalog(id, catalog), err)
	}))
	r.Get("/mcp-servers/{id}/catalog", wrap("mcp", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50, "revision", "digest"); err != nil {
			writeRuntimeError(w, err)
			return
		}
		revision, err := positiveRevision(req.URL.Query().Get("revision"))
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		id := chi.URLParam(req, "id")
		catalog, err := e.Servers.Catalog(id, revision, req.URL.Query().Get("digest"))
		sendExtension(w, 200, publicMCPCatalog(id, catalog), err)
	}))
	registerExecutionRoutes(r, wrap)
}

// registerResourceRuleRoutes is kept separate from extension catalog routes:
// rules are durable, versioned policy inputs consumed while creating a session
// environment snapshot. The parent router mounts this beside the other Agent
// capability endpoints.
func registerResourceRuleRoutes(r chi.Router, service runtimeService) {
	leaseList := func(w http.ResponseWriter, req *http.Request) {
		m, ok := service.(*Manager)
		if !ok {
			writeRuntimeError(w, closedError())
			return
		}
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		leases, err := m.ResourceLeases(req.Context())
		sendExtension(w, 200, leases, err)
	}
	leaseReconcile := func(w http.ResponseWriter, req *http.Request) {
		m, ok := service.(*Manager)
		if !ok {
			writeRuntimeError(w, closedError())
			return
		}
		in, err := readAgentInput[struct {
			Evidence string `json:"evidence"`
			Decision string `json:"decision"`
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		lease, err := m.ReconcileProbeLease(req.Context(), chi.URLParam(req, "id"), in.Evidence, in.Decision)
		sendExtension(w, 200, lease, err)
	}
	for _, path := range []string{"/resource-locks", "/resource-leases"} {
		r.Get(path, leaseList)
		r.Post(path+"/{id}/reconcile", leaseReconcile)
	}
	r.Get("/execution-runtimes", func(w http.ResponseWriter, req *http.Request) {
		m, ok := service.(*Manager)
		if !ok {
			writeRuntimeError(w, &Error{503, "execution-unavailable", "容器执行服务未就绪"})
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			writeRuntimeError(w, closedError())
			return
		}
		if e, ok := m.deps.Catalog.(*Extensions); ok && e.Executor != nil {
			shared.SendJSON(w, 200, e.Executor.Runtimes())
			return
		}
		shared.SendJSON(w, 200, []execution.Runtime{})
	})
	wrap := func(fn func(*Manager, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			m, ok := service.(*Manager)
			if !ok || m == nil {
				writeRuntimeError(w, &Error{503, "resource-rules-unavailable", "资源规则服务不可用"})
				return
			}
			m.mu.Lock()
			closed := m.closed
			m.mu.Unlock()
			if closed {
				writeRuntimeError(w, closedError())
				return
			}
			fn(m, w, req)
		}
	}
	r.Get("/resource-rules", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		value, err := m.ResourceRules(req.Context())
		sendExtension(w, http.StatusOK, value, err)
	}))
	r.Post("/resource-rules", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[ResourceRuleInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		value, err := m.PutResourceRule(req.Context(), "", 0, in)
		sendExtension(w, http.StatusCreated, value, err)
	}))
	r.Get("/resource-rules/{id}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		revision, err := extensionRevision(req, false)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		value, err := m.GetResourceRule(req.Context(), chi.URLParam(req, "id"), revision)
		sendExtension(w, http.StatusOK, value, err)
	}))
	r.Put("/resource-rules/{id}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[struct {
			ResourceRuleInput
			ExpectedRevision int `json:"expectedRevision"`
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		value, err := m.PutResourceRule(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision, in.ResourceRuleInput)
		sendExtension(w, http.StatusOK, value, err)
	}))
}

type mcpCatalogProjection struct {
	mcp.Catalog
	ModelAliases    map[string]string `json:"modelAliases"`
	ResourceAliases map[string]string `json:"resourceAliases"`
	PromptAliases   map[string]string `json:"promptAliases"`
}

func publicMCPCatalog(serverID string, catalog mcp.Catalog) mcpCatalogProjection {
	projection := mcpCatalogProjection{Catalog: catalog, ModelAliases: map[string]string{}, ResourceAliases: map[string]string{}, PromptAliases: map[string]string{}}
	for _, tool := range catalog.Tools {
		projection.ModelAliases[tool.Name] = capabilityAlias("mcp", serverID, tool.Name)
	}
	for _, resource := range catalog.Resources {
		projection.ResourceAliases[resource.URI] = capabilityAlias("resource", serverID, resource.URI)
	}
	for _, prompt := range catalog.Prompts {
		projection.PromptAliases[prompt.Name] = capabilityAlias("prompt", serverID, prompt.Name)
	}
	return projection
}

type enabledInput struct {
	ExpectedRevision int   `json:"expectedRevision"`
	Enabled          *bool `json:"enabled"`
}

func readEnabledInput(w http.ResponseWriter, req *http.Request) (enabledInput, error) {
	in, err := readAgentInput[enabledInput](w, req)
	if err != nil {
		return in, err
	}
	if in.Enabled == nil || in.ExpectedRevision < 1 {
		return in, bad("invalid-enabled-input", "启停操作必须指定 enabled 和当前修订")
	}
	return in, nil
}

func sendExtension(w http.ResponseWriter, status int, value any, err error) {
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	shared.SendJSON(w, status, value)
}
func positiveRevision(raw string) (int, error) {
	revision, err := strconv.Atoi(raw)
	if err != nil || revision < 1 || revision > 2147483647 || strconv.Itoa(revision) != raw {
		return 0, bad("invalid-revision", "修订必须为正整数")
	}
	return revision, nil
}
func extensionRevision(req *http.Request, required bool) (int, error) {
	if _, err := runtimeQuery(req, 50, "revision"); err != nil {
		return 0, err
	}
	raw := req.URL.Query().Get("revision")
	if raw == "" && !required {
		return 0, nil
	}
	return positiveRevision(raw)
}

func registerExecutionRoutes(r chi.Router, wrap func(string, func(*Extensions, http.ResponseWriter, *http.Request)) http.HandlerFunc) {
	r.Get("/execution-profiles", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		items, err := e.Config.ListProfiles()
		sendExtension(w, 200, items, err)
	}))
	r.Get("/execution-profiles/{id}", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		revision, err := extensionRevision(req, false)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Config.GetProfile(chi.URLParam(req, "id"), revision, true)
		sendExtension(w, 200, item, err)
	}))
	r.Post("/execution-profiles", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[execconfig.ProfileInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if in.ID != "" {
			writeRuntimeError(w, bad("invalid-id", "新建执行配置不能指定编号"))
			return
		}
		item, err := e.Config.PutProfile(in)
		sendExtension(w, 201, item, err)
	}))
	r.Put("/execution-profiles/{id}", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[execconfig.ProfileInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		id := chi.URLParam(req, "id")
		if in.ID != "" && in.ID != id {
			writeRuntimeError(w, bad("invalid-id", "执行配置编号与路径不一致"))
			return
		}
		in.ID = id
		item, err := e.Config.PutProfile(in)
		sendExtension(w, 200, item, err)
	}))
	r.Put("/execution-profiles/{id}/enabled", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readEnabledInput(w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Config.SetProfileEnabled(chi.URLParam(req, "id"), in.ExpectedRevision, *in.Enabled)
		sendExtension(w, 200, item, err)
	}))
	r.Get("/grants", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		items, err := e.Config.ListGrants()
		sendExtension(w, 200, items, err)
	}))
	r.Get("/grants/{id}", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		revision, err := extensionRevision(req, false)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Config.GetGrant(chi.URLParam(req, "id"), revision, true)
		sendExtension(w, 200, item, err)
	}))
	r.Post("/grants", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[execconfig.GrantInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if in.ID != "" {
			writeRuntimeError(w, bad("invalid-id", "新建执行授权不能指定编号"))
			return
		}
		item, err := e.Config.PutGrant(in)
		sendExtension(w, 201, item, err)
	}))
	r.Put("/grants/{id}", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readAgentInput[execconfig.GrantInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		id := chi.URLParam(req, "id")
		if in.ID != "" && in.ID != id {
			writeRuntimeError(w, bad("invalid-id", "执行授权编号与路径不一致"))
			return
		}
		in.ID = id
		item, err := e.Config.PutGrant(in)
		sendExtension(w, 200, item, err)
	}))
	r.Put("/grants/{id}/enabled", wrap("execution", func(e *Extensions, w http.ResponseWriter, req *http.Request) {
		in, err := readEnabledInput(w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		item, err := e.Config.SetGrantEnabled(chi.URLParam(req, "id"), in.ExpectedRevision, *in.Enabled)
		sendExtension(w, 200, item, err)
	}))
}

type skillImportBody struct {
	skills.ImportInput
	Credential string `json:"credential,omitempty"`
}

// ZIP 流只接收 metadata、archive 两个部分；尾部非法部分必须在导入被接受之前报错。
func readSkillImport(w http.ResponseWriter, req *http.Request) (skills.ImportInput, io.Reader, error) {
	media, _, err := mime.ParseMediaType(req.Header.Get("Content-Type"))
	if err != nil {
		return skills.ImportInput{}, nil, bad("invalid-content-type", "技能导入需要 JSON 或 multipart/form-data")
	}
	if media == "application/json" {
		body, err := readAgentInput[skillImportBody](w, req)
		if err != nil {
			return skills.ImportInput{}, nil, err
		}
		body.ImportInput.Credential = body.Credential
		return body.ImportInput, nil, nil
	}
	if media != "multipart/form-data" {
		return skills.ImportInput{}, nil, bad("invalid-content-type", "技能导入需要 JSON 或 multipart/form-data")
	}
	req.Body = http.MaxBytesReader(w, req.Body, skills.DefaultLimits().ArchiveBytes+int64(DefaultLimits().InputBytes)+65536)
	reader, err := req.MultipartReader()
	if err != nil {
		return skills.ImportInput{}, nil, bad("invalid-upload", "技能上传格式无效")
	}
	meta, err := reader.NextPart()
	if err != nil || meta.FormName() != "metadata" || meta.FileName() != "" {
		return skills.ImportInput{}, nil, bad("invalid-upload", "技能上传第一部分必须是 metadata JSON")
	}
	raw, err := io.ReadAll(io.LimitReader(meta, int64(DefaultLimits().InputBytes)+1))
	if err != nil || len(raw) > DefaultLimits().InputBytes {
		return skills.ImportInput{}, nil, bad("invalid-upload", "技能导入元数据超过限制")
	}
	metadataReq := req.Clone(req.Context())
	metadataReq.Header = req.Header.Clone()
	metadataReq.Header.Set("Content-Type", "application/json")
	metadataReq.Body = io.NopCloser(bytes.NewReader(raw))
	body, err := readAgentInput[skillImportBody](w, metadataReq)
	if err != nil {
		return skills.ImportInput{}, nil, err
	}
	body.ImportInput.Credential = body.Credential
	if body.Source.Kind != "zip" {
		return skills.ImportInput{}, nil, bad("invalid-upload", "multipart 技能导入只接受 ZIP 来源")
	}
	archive, err := reader.NextPart()
	if err != nil || archive.FormName() != "archive" {
		return skills.ImportInput{}, nil, bad("invalid-upload", "技能上传第二部分必须是 archive")
	}
	return body.ImportInput, &lastMultipartPart{part: archive, reader: reader}, nil
}

type lastMultipartPart struct {
	part   *multipart.Part
	reader *multipart.Reader
	done   bool
}

func (p *lastMultipartPart) Read(b []byte) (int, error) {
	if p.done {
		return 0, io.EOF
	}
	n, err := p.part.Read(b)
	if err == io.EOF {
		p.done = true
		_, nextErr := p.reader.NextPart()
		if !errors.Is(nextErr, io.EOF) {
			return n, bad("invalid-upload", "技能上传包含多余部分或未完整结束")
		}
	}
	return n, err
}
