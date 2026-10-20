package harness

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// Extensions 的资源由装配层构造并注入；Worker 永远不接触这些对象。
type Extensions struct {
	MountRoot       string
	InspectFileRoot func(context.Context, string, bool) (FileRootIdentity, error)
	registry        *tools.Runtime
	BuiltinSchemas  func() []tools.PublicSchema
	Skills          *skills.Store
	Servers         *mcp.Store
	MCP             *mcp.Client
	Config          *execconfig.Store
	Executor        *execution.Executor
	Workspaces      *workspace.Store
	// 仅保存可公开的装配诊断，不包含配置正文或凭据。
	SkillsReason    string
	MCPReason       string
	ExecutionReason string
}

func capabilityAlias(prefix, id, name string) string {
	s := sha256.Sum256([]byte(id + "\x00" + name))
	return prefix + "_" + hex.EncodeToString(s[:12])
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func emptyParameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
}

func (e *Extensions) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	return e.snapshot(ctx, env, false)
}

func (e *Extensions) snapshot(ctx context.Context, env Environment, modern bool) (CapabilitySnapshot, error) {
	s := CapabilitySnapshot{Environment: env, Tools: []Capability{}}
	if runtimeAccessEnabled(ctx) {
		s.AuthorizationMode = AuthorizationOnDemand
	}
	s.Environment.Skills = append([]RevisionRef(nil), env.Skills...)
	s.Environment.Servers = append([]RevisionRef(nil), env.Servers...)
	builtinNames := map[string]bool{}
	if e.BuiltinSchemas != nil {
		for _, schema := range e.BuiltinSchemas() {
			if schema.Metadata.Exposure == "agent" || allowed(schema.Name) {
				builtinNames[schema.Name] = true
			}
		}
	}
	if len(env.Skills) > 0 && e.SkillsReason != "" {
		return s, bad("skill-unavailable", e.SkillsReason)
	}
	if len(env.Servers) > 0 && e.MCPReason != "" {
		return s, bad("mcp-unavailable", e.MCPReason)
	}
	if (len(env.ExecutionProfiles) > 0 || len(env.Grants) > 0) && e.ExecutionReason != "" {
		return s, bad("execution-unavailable", e.ExecutionReason)
	}
	if len(env.Skills) > 32 || len(env.Servers) > 32 || len(env.Tools) > 128 || len(env.Resources) > 64 || len(env.ExecutionProfiles) > 16 || len(env.Grants) > 32 || len(env.TrustedReadOnly) > 256 {
		return s, bad("environment-limit", "会话环境条目超过限制")
	}
	for _, refs := range [][]RevisionRef{env.Skills, env.Servers, env.ExecutionProfiles, env.Grants} {
		seen := map[string]bool{}
		for _, ref := range refs {
			if ref.ID == "" || ref.Revision < 1 || seen[ref.ID] {
				return s, bad("duplicate-environment-ref", "环境能力编号必须唯一且固定具体修订")
			}
			seen[ref.ID] = true
		}
	}
	for _, values := range [][]string{env.Tools, env.TrustedReadOnly} {
		seen := map[string]bool{}
		for _, value := range values {
			if value == "" || seen[value] {
				return s, bad("duplicate-environment-ref", "环境能力别名不能为空或重复")
			}
			seen[value] = true
		}
	}
	serverIDs := map[string]bool{}
	for _, ref := range env.Servers {
		serverIDs[ref.ID] = true
	}
	resourceKeys := map[string]bool{}
	for _, ref := range env.Resources {
		key := ref.ServerID + "\x00" + ref.URI
		if !serverIDs[ref.ServerID] || ref.URI == "" || resourceKeys[key] {
			return s, bad("resource-denied", "资料授权必须唯一且属于已固定的 MCP 服务")
		}
		resourceKeys[key] = true
	}
	for _, ref := range env.ExecutionProfiles {
		if e.Config == nil {
			return s, bad("execution-unavailable", "执行配置未就绪")
		}
		p, err := e.Config.GetProfile(ref.ID, ref.Revision, false)
		if err != nil {
			return s, err
		}
		if ref.Revision < 1 {
			return s, bad("revision-required", "执行配置必须固定具体修订")
		}
		s.Profiles = append(s.Profiles, p)
	}
	for _, ref := range env.Grants {
		if e.Config == nil {
			return s, bad("execution-unavailable", "授权配置未就绪")
		}
		g, err := e.Config.GetGrant(ref.ID, ref.Revision, false)
		if err != nil {
			return s, err
		}
		if ref.Revision < 1 {
			return s, bad("revision-required", "授权必须固定具体修订")
		}
		s.Grants = append(s.Grants, g)
	}
	for _, name := range env.Tools {
		if name != BashExec && name != BashScript {
			continue
		}
		if e.Executor == nil || e.Workspaces == nil {
			return s, bad("execution-unavailable", "Bash 能力需要受管执行器与任务工作区服务")
		}
		capability, ok := bashCapability(name, s.Profiles, s.Grants, e.Executor != nil)
		if runtimeAccessEnabled(ctx) {
			capability, ok = demandBashCapability(name), true
		}
		if !ok {
			return s, bad("execution-unavailable", "Bash 能力必须绑定已启用的 Bash 执行配置与执行器")
		}
		s.Tools = append(s.Tools, capability)
	}
	for index, ref := range env.Skills {
		if e.Skills == nil {
			return s, bad("skill-unavailable", "技能存储未就绪")
		}
		p, err := e.Skills.Get(ref.ID, ref.Revision, false)
		if err != nil {
			return s, err
		}
		if ref.Revision < 1 || ref.Digest != "" && ref.Digest != p.Digest {
			return s, bad("skill-revision", "技能修订或摘要无效")
		}
		ref.Digest = p.Digest
		s.Environment.Skills[index] = ref
		s.SkillSummaries = append(s.SkillSummaries, SkillSummary{Ref: ref, Name: p.Manifest.Name, Description: p.Manifest.Description})
		paths := []string{}
		scripts := []string{}
		for _, f := range p.Files {
			paths = append(paths, f.Path)
			if strings.HasPrefix(f.Path, "scripts/") {
				scripts = append(scripts, f.Path)
			}
		}
		parameters, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "required": []string{"path"}, "properties": map[string]any{"path": map[string]any{"type": "string", "enum": paths}}})
		if modern {
			parameters = skillReadParameters()
		}
		s.Tools = append(s.Tools, Capability{SearchNames: []string{p.Manifest.Name}, Name: capabilityAlias("skill", ref.ID, "load"), Description: "加载技能 " + p.Manifest.Name + " 的 SKILL.md 或参考文件。" + p.Manifest.Description, Parameters: parameters, Source: "skill-load", Ref: ref, ReadOnly: true})
		if len(scripts) > 0 && (len(s.Profiles) > 0 || runtimeAccessEnabled(ctx)) && e.Executor != nil {
			profileIDs := []string{}
			grantIDs := []string{""}
			for _, p := range s.Profiles {
				profileIDs = append(profileIDs, p.ID)
			}
			for _, g := range s.Grants {
				grantIDs = append(grantIDs, g.ID)
			}
			params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "required": []string{"path", "profileId", "grantId", "argv"}, "properties": map[string]any{"path": map[string]any{"type": "string", "enum": scripts}, "profileId": map[string]any{"type": "string", "enum": profileIDs}, "grantId": map[string]any{"type": "string", "enum": grantIDs}, "argv": map[string]any{"type": "array", "maxItems": 64, "items": map[string]any{"type": "string", "maxLength": 4096}}}})
			if modern {
				var schema map[string]any
				_ = json.Unmarshal(params, &schema)
				schema["properties"].(map[string]any)["path"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}
				params, _ = json.Marshal(schema)
			}
			if runtimeAccessEnabled(ctx) {
				params = demandScriptParameters()
			}
			s.Tools = append(s.Tools, Capability{SearchNames: []string{p.Manifest.Name}, Name: capabilityAlias("script", ref.ID, "run"), Description: "审批后在受限容器执行已加载技能 " + p.Manifest.Name + " 的脚本；文件保留在当前任务工作区。", Parameters: params, Source: "script", Ref: ref})
		}
	}
	for index, ref := range env.Servers {
		if e.Servers == nil || e.MCP == nil {
			return s, bad("mcp-unavailable", "MCP 尚未就绪")
		}
		if ref.Revision < 1 {
			return s, bad("revision-required", "MCP 服务必须固定具体修订")
		}
		server, err := e.Servers.Resolve(ref.ID, ref.Revision, false)
		if err != nil {
			return s, err
		}
		if server.Stdio != nil && server.Stdio.GrantID != "" && !runtimeAccessEnabled(ctx) {
			bound := false
			for _, g := range s.Grants {
				bound = bound || (g.ID == server.Stdio.GrantID && g.Revision == server.Stdio.GrantRevision)
			}
			if !bound {
				return s, bad("mcp-grant-denied", "MCP stdio 固定授权必须同时选入会话环境")
			}
		}
		catalog, err := e.Servers.Catalog(ref.ID, ref.Revision, ref.Digest)
		if err != nil {
			return s, err
		}
		ref.Digest = catalog.Digest
		s.Environment.Servers[index] = ref
		for _, t := range catalog.Tools {
			alias := capabilityAlias("mcp", ref.ID, t.Name)
			if !contains(env.Tools, alias) {
				continue
			}
			// 只读权限必须由管理员本地声明，远端 annotations 不构成授权。
			s.Tools = append(s.Tools, Capability{SearchNames: []string{server.Name, t.Name}, Name: alias, Description: t.Description, Parameters: t.InputSchema, OutputSchema: t.OutputSchema, Source: "mcp-tool", Ref: ref, OriginalName: t.Name, CatalogDigest: catalog.Digest, ReadOnly: contains(env.TrustedReadOnly, alias)})
		}
		for _, r := range env.Resources {
			if r.ServerID != ref.ID {
				continue
			}
			found := false
			for _, item := range catalog.Resources {
				if item.URI == r.URI {
					found = true
				}
			}
			if !found {
				return s, bad("resource-not-found", "授权资料不在 MCP 发现目录中")
			}
			s.Tools = append(s.Tools, Capability{Name: capabilityAlias("resource", ref.ID, r.URI), Description: "读取 MCP 资料：" + r.URI, Parameters: emptyParameters(), Source: "mcp-resource", Ref: ref, OriginalName: r.URI, CatalogDigest: catalog.Digest, ReadOnly: true})
		}
		for _, p := range catalog.Prompts {
			props := map[string]any{}
			required := []string{}
			for _, arg := range p.Arguments {
				props[arg.Name] = map[string]any{"type": "string"}
				if arg.Required {
					required = append(required, arg.Name)
				}
			}
			params, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "properties": props, "required": required})
			s.Materials = append(s.Materials, Capability{Name: capabilityAlias("prompt", ref.ID, p.Name), Description: p.Description, Parameters: params, Source: "mcp-prompt", Ref: ref, OriginalName: p.Name, CatalogDigest: catalog.Digest, ReadOnly: true})
		}
	}
	// These capabilities are implemented by the harness itself. Register them
	// before validating the selected names so they follow the same fixed
	// snapshot path as MCP and skill capabilities.
	for _, name := range env.Tools {
		if capability, ok := taskWorkspaceCapability(name); ok {
			if e.Workspaces == nil {
				return s, bad("workspace-unavailable", "任务工作区服务未装配")
			}
			found := false
			for _, existing := range s.Tools {
				found = found || existing.Name == capability.Name
			}
			if !found {
				s.Tools = append(s.Tools, capability)
			}
		}
	}
	for _, name := range env.Tools {
		if allowed(name) || builtinNames[name] {
			continue
		}
		found := false
		for _, c := range s.Tools {
			found = found || c.Name == name
		}
		if !found {
			return s, bad("tool-not-found", "所选工具不在固定能力目录中")
		}
	}
	for _, name := range env.TrustedReadOnly {
		found := (allowed(name) || builtinNames[name]) && contains(env.Tools, name)
		for _, c := range append(append([]Capability{}, s.Tools...), s.Materials...) {
			found = found || c.Name == name
		}
		if !found {
			return s, bad("trusted-tool-not-found", "可信只读声明必须引用环境中已固定的能力")
		}
	}
	raw, err := json.Marshal(s)
	if err != nil || len(raw) > 4<<20 || len(s.Tools) > 256 || len(s.Materials) > 128 {
		return s, bad("snapshot-limit", "能力快照超过 4 MiB、256 个工具或 128 个提示模板的上限")
	}
	return s, nil
}
func (e *Extensions) Validate(c Capability, args json.RawMessage) error {
	if c.Source == "workspace" {
		if err := mcp.Validate(c.Parameters, args); err != nil {
			return err
		}
		return validateTaskWorkspaceArgs(c, args)
	}
	if isBashSource(c.Source) {
		return e.validateBashArguments(c, args)
	}
	return mcp.Validate(c.Parameters, args)
}

type scriptArguments struct {
	Path      string   `json:"path"`
	ProfileID string   `json:"profileId"`
	GrantID   string   `json:"grantId"`
	Args      []string `json:"argv"`
}

func (e *Extensions) Prepare(ctx context.Context, s CapabilitySnapshot, o Operation) (Operation, error) {
	if s.AuthorizationMode == AuthorizationOnDemand {
		return e.prepareDemandOperation(ctx, s, o)
	}
	if isBashSource(o.Capability.Source) {
		return e.prepareBash(ctx, s, o)
	}
	if o.Capability.Source != "script" {
		if o.Capability.Source == "mcp-tool" || o.Capability.Source == "mcp-resource" || o.Capability.Source == "mcp-prompt" {
			server, err := e.Servers.Resolve(o.Capability.Ref.ID, o.Capability.Ref.Revision, true)
			if err != nil {
				return o, err
			}
			if server.Stdio != nil {
				plan := &ExecutionPlan{Profile: execconfig.Profile{Name: "MCP stdio", Enabled: true, Image: server.Stdio.Image, Runtime: "bash", Command: append([]string(nil), server.Stdio.Command...), TimeoutSeconds: 300, CPUMillis: 1000, MemoryBytes: 512 << 20, PIDs: 128}}
				if server.Stdio.GrantID != "" {
					for _, g := range s.Grants {
						if g.ID == server.Stdio.GrantID && g.Revision == server.Stdio.GrantRevision {
							plan.Grant = copyExecutionGrant(g)
						}
					}
					if plan.Grant == nil {
						return o, bad("mcp-grant-denied", "MCP stdio 授权不在固定环境中")
					}
				}
				o.Execution = plan
			}
		}
		return o, nil
	}
	var args scriptArguments
	if err := json.Unmarshal([]byte(o.ArgumentsJSON), &args); err != nil {
		return o, bad("invalid-script", "脚本参数无效")
	}
	plan := &ExecutionPlan{}
	for _, p := range s.Profiles {
		if p.ID == args.ProfileID {
			plan.Profile = p
			plan.Profile.Command = append([]string(nil), p.Command...)
		}
	}
	if plan.Profile.ID == "" {
		return o, bad("profile-denied", "执行配置未获准")
	}
	if args.GrantID != "" {
		for _, g := range s.Grants {
			if g.ID == args.GrantID {
				plan.Grant = copyExecutionGrant(g)
			}
		}
		if plan.Grant == nil {
			return o, bad("grant-denied", "挂载或出网授权未获准")
		}
	}
	p, err := e.Skills.Get(o.Capability.Ref.ID, o.Capability.Ref.Revision, true)
	if err != nil {
		return o, err
	}
	for _, f := range p.Files {
		if f.Path == args.Path && strings.HasPrefix(f.Path, "scripts/") {
			plan.ScriptDigest = f.Digest
		}
	}
	if plan.ScriptDigest == "" {
		return o, bad("script-denied", "脚本不在固定技能包中")
	}
	o.Execution = plan
	return o, nil
}

func copyExecutionGrant(g execconfig.Grant) *execconfig.Grant {
	g.Directories = append([]execconfig.Directory(nil), g.Directories...)
	g.Network = append([]execconfig.NetworkEndpoint(nil), g.Network...)
	g.PrivateCIDRs = append([]string(nil), g.PrivateCIDRs...)
	g.Resources = append([]execconfig.Resource(nil), g.Resources...)
	return &g
}
func (e *Extensions) Check(ctx context.Context, s CapabilitySnapshot, o Operation) error {
	ctx = mcp.WithScope(ctx, o.ID)
	c := o.Capability
	switch c.Source {
	case "builtin":
		return nil
	case "workspace":
		if e.Workspaces == nil {
			return bad("workspace-unavailable", "任务工作区服务不可用")
		}
		return e.Validate(c, json.RawMessage(o.ArgumentsJSON))
	case BashSource, BashExec, BashScript:
		if e.Executor == nil || e.Workspaces == nil {
			return bad("execution-unavailable", "Bash 执行器或工作区不可用")
		}
		prepared, err := e.Prepare(ctx, s, o)
		if err != nil {
			return err
		}
		if digestJSON(prepared.Execution) != digestJSON(o.Execution) {
			return bad("execution-changed", "Bash 执行配置与审批快照不符")
		}
		return nil
	case "skill-load", "script":
		p, err := e.Skills.Get(c.Ref.ID, c.Ref.Revision, true)
		if err != nil {
			return err
		}
		if p.Digest != c.Ref.Digest {
			return bad("skill-changed", "技能包摘要发生变化")
		}
		if c.Source == "script" {
			prepared, err := e.Prepare(ctx, s, o)
			if err != nil {
				return err
			}
			if digestJSON(prepared.Execution) != digestJSON(o.Execution) {
				return bad("execution-changed", "执行配置与审批快照不符")
			}
			if e.Executor == nil {
				return bad("execution-unavailable", "容器执行器不可用")
			}
		}
	case "mcp-tool", "mcp-resource", "mcp-prompt":
		server, err := e.Servers.Resolve(c.Ref.ID, c.Ref.Revision, true)
		if err != nil {
			return err
		}
		prepared, err := e.Prepare(ctx, s, o)
		if err != nil {
			return err
		}
		if digestJSON(prepared.Execution) != digestJSON(o.Execution) {
			return bad("execution-changed", "MCP stdio 容器配置与审批快照不符")
		}
		if server.Stdio != nil {
			if err := tools.Revalidate(ctx); err != nil {
				return err
			}
		}
		return e.MCP.CheckCatalog(ctx, server, c.CatalogDigest)
	default:
		return bad("unknown-capability", "未知能力来源")
	}
	return nil
}

// CloseOperation ends an operation-scoped MCP stdio generation. It is safe to
// call repeatedly; HTTP transports and non-MCP capabilities are unaffected.
func (e *Extensions) CloseOperation(ctx context.Context, o Operation) error {
	if e == nil || e.MCP == nil || e.Servers == nil || (o.Capability.Source != "mcp-tool" && o.Capability.Source != "mcp-resource" && o.Capability.Source != "mcp-prompt") || o.Execution == nil {
		return nil
	}
	closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return e.MCP.CloseServer(mcp.WithScope(closeCtx, o.ID), o.Capability.Ref.ID, o.Capability.Ref.Revision)
}
func contentDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

// readableBlocks 只把文本送给模型；二进制、链接与其他内容块只保留类型及未读取状态。
func readableBlocks(blocks []json.RawMessage) []any {
	out := []any{}
	for _, raw := range blocks {
		obj, err := jsonvalue.Object(raw)
		if err != nil {
			continue
		}
		kind, _ := obj["type"].(string)
		if text, ok := obj["text"].(string); ok && (kind == "text" || kind == "") {
			out = append(out, map[string]any{"type": "text", "text": text, "uri": obj["uri"]})
		} else {
			out = append(out, map[string]any{"type": kind, "status": "unread"})
		}
	}
	return out
}
func (e *Extensions) Execute(ctx context.Context, s CapabilitySnapshot, o Operation) (CapabilityResult, error) {
	if e.registry == nil {
		return CapabilityResult{}, bad("dispatch-required", "扩展能力必须经已授权的工具注册表派发")
	}
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return CapabilityResult{}, err
	}
	value, err := e.registry.Execute(ctx, o.Capability.Name, args)
	if err != nil {
		return CapabilityResult{}, err
	}
	result, ok := value.(CapabilityResult)
	if !ok {
		return CapabilityResult{}, bad("invalid-result", "扩展能力结果类型无效")
	}
	return result, nil
}

func (e *Extensions) executeBackend(ctx context.Context, s CapabilitySnapshot, o Operation) (CapabilityResult, error) {
	ctx = mcp.WithScope(ctx, o.ID)
	var result CapabilityResult
	c := o.Capability
	switch c.Source {
	case "workspace":
		if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
			return result, err
		}
		return e.executeTaskWorkspace(ctx, o)
	case BashSource, BashExec, BashScript:
		return e.executeBash(ctx, o)
	case "skill-load":
		if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
			return result, err
		}
		var args struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal([]byte(o.ArgumentsJSON), &args)
		body, err := e.Skills.ReadFile(ctx, c.Ref.ID, c.Ref.Revision, args.Path, int64(DefaultLimits().ResultBytes-1024))
		if err != nil {
			return result, err
		}
		if !utf8.Valid(body) || strings.IndexByte(string(body), 0) >= 0 {
			result.Value, _ = json.Marshal(map[string]any{"path": args.Path, "status": "unread", "reason": "非文本资源"})
		} else {
			result.Value, _ = json.Marshal(map[string]any{"path": args.Path, "text": string(body)})
		}
		result.Context = &ContextItem{Source: c.Source, Ref: c.Ref, Path: args.Path, Digest: contentDigest(body)}
		return result, nil
	case "script":
		return e.executeScript(ctx, o)
	case "mcp-tool", "mcp-resource", "mcp-prompt":
		server, err := e.Servers.Resolve(c.Ref.ID, c.Ref.Revision, true)
		if err != nil {
			return result, err
		}
		if server.Stdio == nil {
			if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
				return result, err
			}
		}
		switch c.Source {
		case "mcp-tool":
			value, callErr := e.MCP.CallTool(ctx, server, mcp.Call{RequestID: o.DispatchID, Name: c.OriginalName, Arguments: json.RawMessage(o.ArgumentsJSON), InputSchema: c.Parameters, OutputSchema: c.OutputSchema})
			err = callErr
			if err == nil {
				result.Value, _ = json.Marshal(map[string]any{"content": readableBlocks(value.Content), "structuredContent": value.StructuredContent, "isError": value.IsError})
				if value.IsError {
					result.BusinessError = &Failure{Code: "mcp-tool-error", Message: "MCP 工具返回业务错误"}
				}
			}
		case "mcp-resource":
			value, callErr := e.MCP.ReadResource(ctx, server, o.DispatchID, c.OriginalName)
			err = callErr
			if err == nil {
				result.Value, _ = json.Marshal(map[string]any{"contents": readableBlocks(value.Contents)})
			}
		case "mcp-prompt":
			var args map[string]string
			if json.Unmarshal([]byte(o.ArgumentsJSON), &args) != nil {
				return result, bad("invalid-prompt", "提示模板参数必须是字符串")
			}
			value, callErr := e.MCP.GetPrompt(ctx, server, o.DispatchID, c.OriginalName, args)
			err = callErr
			if err == nil {
				materials := []any{}
				for _, message := range value.Messages {
					materials = append(materials, map[string]any{"sourceRole": message.Role, "content": readableBlocks([]json.RawMessage{message.Content})})
				}
				result.Value, _ = json.Marshal(map[string]any{"description": value.Description, "templateMaterials": materials})
			}
		}
		if err != nil {
			var me *mcp.Error
			if errors.As(err, &me) {
				result.Unknown = me.OutcomeUnknown
			}
			return result, err
		}
		// 服务若回显自身静态凭据，也不能使凭据进入持久事实。
		secrets := []string{server.Credential}
		if server.Stdio != nil {
			for _, v := range server.Stdio.Environment {
				secrets = append(secrets, v)
			}
		}
		result.Value, err = redactResult(result.Value, secrets)
		if err != nil {
			return CapabilityResult{}, bad("invalid-result", "MCP 结果不是有效 JSON")
		}
		if c.Source != "mcp-tool" {
			result.Context = &ContextItem{Source: c.Source, Ref: c.Ref, Path: c.OriginalName, Digest: contentDigest(result.Value)}
		}
		return result, nil
	}
	return result, bad("unknown-capability", "未知能力来源")
}

// 只改 JSON 字符串；凭据等于 true 或数字时也不能破坏布尔和数值令牌。
func redactResult(raw json.RawMessage, secrets []string) (json.RawMessage, error) {
	value, err := jsonvalue.Decode(raw)
	if err != nil {
		return nil, err
	}
	redact := func(text string) string {
		for _, secret := range secrets {
			if secret != "" {
				text = strings.ReplaceAll(text, secret, "[凭据已隐藏]")
			}
		}
		return text
	}
	var walk func(any) any
	walk = func(v any) any {
		switch typed := v.(type) {
		case string:
			return redact(typed)
		case []any:
			for i, item := range typed {
				typed[i] = walk(item)
			}
			return typed
		case map[string]any:
			out := map[string]any{}
			for key, item := range typed {
				out[redact(key)] = walk(item)
			}
			return out
		default:
			return v
		}
	}
	return json.Marshal(walk(value))
}
func (e *Extensions) executeScript(ctx context.Context, o Operation) (CapabilityResult, error) {
	var result CapabilityResult
	if o.Execution == nil || e.Workspaces == nil || e.Executor == nil {
		return result, bad("execution-unavailable", "执行快照或工作区不可用")
	}
	var args scriptArguments
	_ = json.Unmarshal([]byte(o.ArgumentsJSON), &args)
	skill, err := e.Skills.Get(o.Capability.Ref.ID, o.Capability.Ref.Revision, true)
	if err != nil {
		return result, err
	}
	skillRead, skillWrite := io.Pipe()
	defer skillRead.Close()
	go func() {
		tw := tar.NewWriter(skillWrite)
		var failure error
		for _, f := range skill.Files {
			body, readErr := e.Skills.ReadFile(ctx, skill.ID, skill.Revision, f.Path, 64<<20)
			if readErr != nil {
				failure = readErr
				break
			}
			if failure = tw.WriteHeader(&tar.Header{Name: f.Path, Mode: 0444, Size: int64(len(body))}); failure != nil {
				break
			}
			if _, failure = tw.Write(body); failure != nil {
				break
			}
		}
		failure = errors.Join(failure, tw.Close())
		_ = skillWrite.CloseWithError(failure)
	}()
	workRead, workWrite := io.Pipe()
	defer workRead.Close()
	go func() {
		_, err := e.Workspaces.Export(ctx, o.TaskID, o.WorkspaceRevision, workWrite)
		_ = workWrite.CloseWithError(err)
	}()
	out, err := os.CreateTemp("", "elysian-workspace-*.tar")
	if err != nil {
		return result, bad("workspace-storage", "无法准备工作区导出")
	}
	defer os.Remove(out.Name())
	defer out.Close()
	value, err := e.Executor.RunScript(ctx, execution.ScriptRequest{ID: o.DispatchID, Profile: o.Execution.Profile, Grant: o.Execution.Grant, ScriptPath: args.Path, Args: args.Args, SkillArchive: skillRead, WorkspaceArchive: workRead, WorkspaceOutput: out})
	if err != nil {
		var ee *execution.Error
		if errors.As(err, &ee) {
			result.Unknown = ee.OutcomeUnknown
		}
		return result, err
	}
	if _, err = out.Seek(0, io.SeekStart); err != nil {
		return result, bad("workspace-storage", "无法读取已确认的工作区导出")
	}
	v, err := e.Workspaces.PrepareImport(ctx, o.TaskID, o.WorkspaceRevision, out)
	if err != nil {
		return result, err
	}
	result.Workspace = &v
	result.Value, _ = json.Marshal(value)
	if value.ExitCode != 0 {
		result.BusinessError = &Failure{Code: "script-exit", Message: "脚本以非零退出码结束，已确认的文件变化仍保存"}
	}
	return result, nil
}
