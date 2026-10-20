package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/tools"
)

func requestedAccessSchema() map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{
		"directories":  map[string]any{"type": "array", "maxItems": 16, "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"path", "access"}, "properties": map[string]any{"path": map[string]any{"type": "string"}, "access": map[string]any{"type": "string", "enum": []string{"ro", "rw"}}}}},
		"network":      map[string]any{"type": "array", "maxItems": 64, "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"scheme", "host", "port"}, "properties": map[string]any{"scheme": map[string]any{"type": "string", "enum": []string{"http", "https"}}, "host": map[string]any{"type": "string"}, "port": map[string]any{"type": "integer", "minimum": 1, "maximum": 65535}}}},
		"privateCidrs": map[string]any{"type": "array", "maxItems": 32, "items": map[string]any{"type": "string"}},
	}}
}
func demandBashCapability(name string) Capability {
	c, _ := bashCapability(name, []execconfig.Profile{{ID: "runtime-bash", Runtime: "bash", Enabled: true}}, nil, true)
	var schema map[string]any
	_ = json.Unmarshal(c.Parameters, &schema)
	props := schema["properties"].(map[string]any)
	delete(props, "profileId")
	delete(props, "grantId")
	props["access"] = requestedAccessSchema()
	if name == BashScript {
		schema["required"] = []string{"path", "argv"}
	} else {
		schema["required"] = []string{"command"}
	}
	c.Parameters, _ = json.Marshal(schema)
	c.Description = "在受限 Bash 容器执行；缺少环境或目录、网络权限时自动暂停请用户确认。access 只声明需求，不授予权限。宿主路径会映射为 /grants/0 等；默认只使用任务工作区。"
	return c
}
func demandScriptParameters() json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "required": []string{"path", "argv", "runtime"}, "properties": map[string]any{
		"path": map[string]any{"type": "string", "minLength": 1, "maxLength": 4096}, "argv": map[string]any{"type": "array", "maxItems": 64, "items": map[string]any{"type": "string", "maxLength": 4096}}, "runtime": map[string]any{"type": "string", "enum": []string{"bash", "python", "node"}}, "access": requestedAccessSchema(),
	}})
	return raw
}
func (e *Extensions) prepareDemandOperation(ctx context.Context, s CapabilitySnapshot, o Operation) (Operation, error) {
	// Once prepared, preserve the exact proposed image and root identity through approval and restart.
	if o.Access != nil {
		if accessDigest(o) != o.Access.Digest {
			return o, bad("access-changed", "运行时授权请求内容已变化")
		}
		return o, nil
	}
	c := o.Capability
	isScript := isBashSource(c.Source) || c.Source == "script"
	isMCP := strings.HasPrefix(c.Source, "mcp-")
	isFile := c.Source == "builtin" && c.Metadata.ResourceType == "filesystem"
	if !isScript && !isMCP && !isFile && (c.Source != "builtin" || c.ReadOnly) {
		return o, nil
	}
	if c.Metadata.Exposure != "" && c.Metadata.Exposure != "agent" {
		return o, bad("tool-human-required", "该操作必须通过人工管理入口执行")
	}
	a := &AccessRequest{Revision: 1, Kind: "platform", Directories: []execconfig.Directory{}, Network: []execconfig.NetworkEndpoint{}, PrivateCIDRs: []string{}, Resources: []execconfig.Resource{}, SessionAllowed: true}
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return o, err
	}
	grant := execconfig.Grant{ID: "authorization-" + o.ID, Revision: 1, Name: "运行时授权", Enabled: true}
	if isScript {
		a.Kind = "script"
		if e.Executor == nil || e.Workspaces == nil {
			return o, bad("execution-unavailable", "受管执行器或任务工作区不可用")
		}
		runtime := "bash"
		if c.Source == "script" {
			runtime, _ = args["runtime"].(string)
		}
		env, resolveErr := e.Executor.ResolveRuntime(ctx, runtime)
		if resolveErr != nil {
			return o, resolveErr
		}
		plan := &ExecutionPlan{Profile: env.Profile}
		a.Runtime = &AccessRuntime{Name: env.Profile.Name, Image: env.Profile.Image, Platform: env.Platform, RequiresDownload: env.RequiresDownload}
		if raw, ok := args["access"]; ok {
			b, _ := json.Marshal(raw)
			if err = json.Unmarshal(b, &grant); err != nil {
				return o, bad("invalid-access", "执行范围格式无效")
			}
		}
		if isBashScript(c) || c.Source == "script" {
			path, _ := args["path"].(string)
			if err = workspace.ValidatePath(path); err != nil {
				return o, err
			}
			if c.Source == "script" {
				if e.Skills == nil {
					return o, bad("skill-unavailable", "技能存储不可用")
				}
				pack, readErr := e.Skills.Get(c.Ref.ID, c.Ref.Revision, true)
				if readErr != nil {
					return o, readErr
				}
				if pack.Digest != c.Ref.Digest {
					return o, bad("skill-changed", "技能包摘要发生变化")
				}
				for _, f := range pack.Files {
					if f.Path == path && strings.HasPrefix(path, "scripts/") {
						plan.ScriptDigest = f.Digest
					}
				}
			} else {
				view, readErr := e.Workspaces.List(ctx, o.TaskID, o.WorkspaceRevision)
				if readErr != nil {
					return o, readErr
				}
				for _, f := range view.Files {
					if f.Path == path {
						plan.ScriptDigest = f.Digest
					}
				}
			}
			if plan.ScriptDigest == "" {
				return o, bad("script-not-found", "脚本不在固定工作区或已加载技能包中")
			}
		}
		o.Execution = plan
	} else if isMCP {
		a.Kind = "mcp"
		if e.Servers == nil {
			return o, bad("mcp-unavailable", "MCP 配置不可用")
		}
		server, readErr := e.Servers.Resolve(c.Ref.ID, c.Ref.Revision, true)
		if readErr != nil {
			return o, readErr
		}
		a.Reason = fmt.Sprintf("使用 MCP 服务「%s」修订 %d 的「%s」，仅匹配当前工具的完整参数。", server.Name, server.Revision, c.OriginalName)
		if server.Stdio != nil {
			if e.Executor == nil {
				return o, bad("execution-unavailable", "MCP 容器执行器不可用")
			}
			if requested := server.Stdio.RequestedAccess; requested != nil {
				grant.Directories = requested.Directories
				grant.Network = requested.Network
				grant.PrivateCIDRs = requested.PrivateCIDRs
			}
			if server.Stdio.GrantID != "" {
				if e.Config == nil {
					return o, bad("grant-unavailable", "旧 MCP 授权配置不可用")
				}
				old, readErr := e.Config.GetGrant(server.Stdio.GrantID, server.Stdio.GrantRevision, true)
				if readErr != nil {
					return o, readErr
				}
				grant.Directories, grant.Network, grant.PrivateCIDRs = old.Directories, old.Network, old.PrivateCIDRs
			}
			env, resolveErr := e.Executor.ResolveMCPRuntime(ctx, server.Stdio.Image)
			if resolveErr != nil {
				return o, resolveErr
			}
			env.Profile.Command = append([]string{}, server.Stdio.Command...)
			o.Execution = &ExecutionPlan{Profile: env.Profile}
			a.Runtime = &AccessRuntime{Name: env.Profile.Name, Image: env.Profile.Image, Platform: env.Platform, RequiresDownload: env.RequiresDownload}
		}
	} else if isFile {
		a.Kind = "file"
		root, _ := args[c.Metadata.ResourceKeyArgument].(string)
		access := "ro"
		if !c.ReadOnly {
			access = "rw"
		}
		if !filepath.IsAbs(root) || filepath.Clean(root) != root {
			return o, bad("invalid-access", "文件根必须是规范的业务绝对路径")
		}
		grant.Directories = []execconfig.Directory{{Path: root, Access: access}}
		if e.InspectFileRoot == nil {
			return o, bad("files-unavailable", "文件目录校验服务不可用")
		}
		identity, inspectErr := e.InspectFileRoot(ctx, root, !c.ReadOnly)
		if inspectErr != nil {
			return o, inspectErr
		}
		o.FileRoot = &identity
	} else {
		id, _ := args[c.Metadata.ResourceKeyArgument].(string)
		if c.Metadata.ResourceType == "" || id == "" || id == "*" {
			return o, bad("resource-denied", "平台操作必须绑定明确的资源对象")
		}
		grant.Resources = []execconfig.Resource{{Domain: c.Metadata.ResourceType, ID: id, Access: "write"}}
	}
	if len(grant.Directories)+len(grant.Network)+len(grant.Resources)+len(grant.PrivateCIDRs) > 0 {
		if err = execconfig.ValidateGrant(grant, e.MountRoot); err != nil {
			return o, err
		}
	}
	if o.Execution != nil {
		o.Execution.Grant = &grant
	}
	a.Directories = append(a.Directories, grant.Directories...)
	a.Network = append(a.Network, grant.Network...)
	a.PrivateCIDRs = append(a.PrivateCIDRs, grant.PrivateCIDRs...)
	a.Resources = append(a.Resources, grant.Resources...)
	o.Access = a
	a.ScopeKey = accessScopeKey(o)
	a.Digest = accessDigest(o)
	return o, nil
}
func accessScopeKey(o Operation) string {
	a := *o.Access
	a.Digest = ""
	a.ScopeKey = ""
	a.Revision = 0
	a.Reason = ""
	if a.Runtime != nil {
		r := *a.Runtime
		r.RequiresDownload = false
		a.Runtime = &r
	}
	// Scope order is irrelevant for permission equality, while operation payload keeps mount order.
	a.Directories = append([]execconfig.Directory{}, a.Directories...)
	sort.Slice(a.Directories, func(i, j int) bool { return a.Directories[i].Path < a.Directories[j].Path })
	a.Network = append([]execconfig.NetworkEndpoint{}, a.Network...)
	sort.Slice(a.Network, func(i, j int) bool { return digestJSON(a.Network[i]) < digestJSON(a.Network[j]) })
	a.PrivateCIDRs = append([]string{}, a.PrivateCIDRs...)
	sort.Strings(a.PrivateCIDRs)
	argsDigest := ""
	if a.Kind == "mcp" {
		raw, err := jsonvalue.Canonical([]byte(o.ArgumentsJSON))
		if err == nil {
			argsDigest = contentDigest(raw)
		}
	}
	tool := o.Capability.Name
	ref, catalog := o.Capability.Ref, o.Capability.CatalogDigest
	// Commands and script bodies may differ only inside the explicitly approved environment and range.
	if a.Kind == "script" {
		tool = "isolated-script"
		ref, catalog = RevisionRef{}, ""
	}
	var profile *execconfig.Profile
	if o.Execution != nil {
		value := o.Execution.Profile
		value.ID, value.Name, value.CreatedAt = "", "", ""
		value.Revision, value.Enabled = 0, false
		value.TimeoutSeconds = 0
		profile = &value
	}
	return digestJSON(struct {
		Profile            *execconfig.Profile
		Tool               string
		Ref                RevisionRef
		Catalog, Arguments string
		Access             AccessRequest
		FileRoot           *FileRootIdentity
	}{profile, tool, ref, catalog, argsDigest, a, o.FileRoot})
}
func accessDigest(o Operation) string {
	if o.Access == nil {
		return ""
	}
	a := *o.Access
	a.Digest = ""
	return digestJSON(struct {
		ID, RunID, Arguments, Snapshot string
		Capability                     Capability
		Execution                      *ExecutionPlan
		FileRoot                       *FileRootIdentity
		Access                         AccessRequest
	}{o.ID, o.RunID, o.ArgumentsJSON, o.SnapshotDigest, o.Capability, o.Execution, o.FileRoot, a})
}
func accessSnapshot(s CapabilitySnapshot, o Operation) CapabilitySnapshot {
	if s.AuthorizationMode != AuthorizationOnDemand || o.Access == nil {
		return s
	}
	s.Grants = []execconfig.Grant{{Enabled: true, Directories: o.Access.Directories, Network: o.Access.Network, PrivateCIDRs: o.Access.PrivateCIDRs, Resources: o.Access.Resources}}
	return s
}

// RuntimeExecutionAuthorization reads only the opaque, verified dispatch payload.
func RuntimeExecutionAuthorization(ctx context.Context, dispatchID string) (*execution.RuntimeAuthorization, error) {
	o, ok := tools.Payload(ctx).(Operation)
	if !ok {
		return probeRuntimeExecutionAuthorization(ctx, dispatchID)
	}
	if o.Access == nil {
		return nil, nil
	}
	if o.DispatchID != dispatchID || o.Authorization == nil || o.Authorization.Digest != o.Access.Digest || accessDigest(o) != o.Access.Digest {
		return nil, errors.New("运行时执行缺少匹配的已确认授权")
	}
	if o.Execution == nil {
		return nil, nil
	}
	auth := &execution.RuntimeAuthorization{ID: o.ID, DispatchID: dispatchID, ScopeID: o.DispatchID, Profile: o.Execution.Profile, Grant: o.Execution.Grant, Platform: o.Access.Runtime.Platform}
	if strings.HasPrefix(o.Capability.Source, "mcp-") {
		auth.ScopeID = o.ID
		auth.ServerID = o.Capability.Ref.ID
		auth.ServerRevision = o.Capability.Ref.Revision
		auth.CatalogDigest = o.Capability.CatalogDigest
	}
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return nil, err
	}
	switch {
	case strings.HasPrefix(o.Capability.Source, "mcp-"):
		auth.Command = append([]string{}, o.Execution.Profile.Command...)
	case o.Capability.Name == BashExec:
		command, _ := args["command"].(string)
		auth.Command = []string{"bash", "--noprofile", "--norc", "-c", command, "elysian-command"}
	default:
		path, _ := args["path"].(string)
		if isBashScript(o.Capability) {
			auth.Command = []string{"bash", "--noprofile", "--norc", "--", "/workspace/" + path}
		} else {
			auth.Command = append([]string{}, o.Execution.Profile.Command...)
			if len(auth.Command) == 0 {
				command := o.Execution.Profile.Runtime
				if command == "python" {
					command = "python3"
				}
				auth.Command = []string{command}
			}
			auth.Command = append(auth.Command, "/bundle/skill/"+path)
		}
		argv, _ := args["argv"].([]any)
		for _, value := range argv {
			arg, ok := value.(string)
			if !ok {
				return nil, errors.New("运行参数无效")
			}
			auth.Command = append(auth.Command, arg)
		}
	}
	return auth, nil
}
