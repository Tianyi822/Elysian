package harness

import (
	"context"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

type registryProvider interface{ Runtime() *tools.Runtime }

func (m *Manager) initializeToolRuntime() error {
	if provider, ok := m.deps.Tools.(registryProvider); ok {
		m.toolRuntime = provider.Runtime()
	}
	if m.toolRuntime == nil {
		var err error
		m.toolRuntime, err = tools.NewManagedRuntime(context.Background())
		if err != nil {
			return err
		}
		m.ownToolRuntime = true
	}
	m.toolAuthority = tools.NewAuthority()
	if err := m.toolRuntime.SetAuthority(m.toolAuthority); err != nil {
		return err
	}
	if extension, ok := m.deps.Catalog.(*Extensions); ok {
		extension.registry = m.toolRuntime
		if m.deps.Tools != nil {
			extension.BuiltinSchemas = m.deps.Tools.Schemas
		}
	}
	return nil
}

func (m *Manager) authorizeDispatch(ctx context.Context, s CapabilitySnapshot, o Operation) (context.Context, error) {
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return nil, err
	}
	binding := tools.AuthorizationBinding{OperationID: o.ID, DispatchID: o.DispatchID, Tool: o.Capability.Name, ArgumentsDigest: tools.ArgumentsDigest(args), SnapshotDigest: s.Digest, CatalogID: s.Digest}
	return m.toolAuthority.Authorize(ctx, binding, o, func(checkCtx context.Context) error {
		if err := m.store.recordsFault(); err != nil {
			return err
		}
		stored, err := readOperation(checkCtx, m.store.db, o.ID)
		if err != nil {
			return err
		}
		if stored.Status != "dispatched" || stored.DispatchID != o.DispatchID || digestJSON(stored) != digestJSON(o) {
			return bad("dispatch-changed", "派发操作与持久化授权不符")
		}
		run, err := m.store.get(checkCtx, o.RunID)
		if err != nil {
			return err
		}
		if run.CancelRequestedAt != "" || run.Status != StateRunning {
			return context.Canceled
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed || m.storageError {
			return context.Canceled
		}
		if err := m.checkOperationAuthorization(checkCtx, o); err != nil {
			return err
		}
		if err := m.checkRevocations(checkCtx, s, o); err != nil {
			return err
		}
		if extensions, ok := m.deps.Catalog.(*Extensions); ok && extensions.Config != nil {
			for _, grant := range s.Grants {
				if _, err := extensions.Config.GetGrant(grant.ID, grant.Revision, false); err != nil {
					return err
				}
			}
		}
		if m.deps.DispatchGuard != nil {
			return m.deps.DispatchGuard()
		}
		return nil
	})
}

func capabilityMetadata(c Capability) tools.Metadata {
	metadata := c.Metadata
	if metadata.Domain == "" {
		metadata.Domain = c.Source
	}
	if metadata.Action == "" {
		metadata.Action = c.Name
	}
	if metadata.Effect == "" {
		if c.ReadOnly {
			metadata.Effect = "read"
		} else {
			metadata.Effect = "write"
		}
	}
	if metadata.Exposure == "" {
		metadata.Exposure = "agent"
	}
	if metadata.Version == "" {
		metadata.Version = "1"
	}
	if metadata.Backend == "" {
		switch c.Source {
		case "workspace":
			metadata.Backend = "workspace"
		case "script", BashSource, BashExec, BashScript:
			metadata.Backend = "container"
		case "mcp-tool", "mcp-resource", "mcp-prompt":
			metadata.Backend = "mcp"
		case "skill-load", "wiki", toolDiscoverySource:
			metadata.Backend = "store"
		default:
			metadata.Backend = "domain"
		}
	}
	metadata.ReadOnly = c.ReadOnly
	return metadata
}

func (m *Manager) registerRunCatalog(s CapabilitySnapshot) error {
	descriptors := []tools.Descriptor{}
	_, native := m.deps.Tools.(registryProvider)
	for _, capability := range append(append([]Capability{}, s.Tools...), s.Materials...) {
		c := capability
		description := c.Description
		if description == "" {
			description = c.Name
		}
		if c.Source == "builtin" && native {
			continue
		}
		var schema map[string]any
		if err := json.Unmarshal(c.Parameters, &schema); err != nil {
			return err
		}
		descriptors = append(descriptors, tools.Descriptor{Name: c.Name, Description: description, JSONParameters: schema, Metadata: capabilityMetadata(c), ValidateArguments: func(args tools.Arguments) error {
			raw, err := json.Marshal(args)
			if err != nil {
				return err
			}
			if c.Source == "builtin" || c.Source == "wiki" {
				return mcp.Validate(c.Parameters, raw)
			}
			if c.Source == toolDiscoverySource {
				_, err := parseToolSearch(raw)
				return err
			}
			if m.deps.Catalog == nil {
				return bad("capability-unavailable", "扩展能力不可用")
			}
			return m.deps.Catalog.Validate(c, raw)
		}, Handler: func(access *kardia.Context, args tools.Arguments) (any, error) {
			ctx := tools.Lifetime(access)
			o, ok := tools.Payload(ctx).(Operation)
			if !ok || digestJSON(o.Capability) != digestJSON(c) || o.SnapshotDigest != s.Digest {
				return nil, bad("dispatch-changed", "工具处理器与固定授权不符")
			}
			if c.Source == toolDiscoverySource {
				if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
					return nil, err
				}
				if s.ToolLoading == onDemandToolsV2 {
					return m.searchToolsV2(ctx, s, o)
				}
				return searchTools(s, json.RawMessage(o.ArgumentsJSON))
			}
			if _, localSkills := m.deps.Catalog.(*Extensions); localSkills && c.Source == "skill-load" && s.ToolLoading == onDemandToolsV2 {
				if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
					return nil, err
				}
				return m.executeSkillLoadV2(ctx, s, o)
			}
			if c.Source == "builtin" {
				if m.deps.Tools == nil {
					return nil, bad("tool-unavailable", "工具依赖不可用")
				}
				value, err := m.deps.Tools.Execute(ctx, c.Name, args)
				result := CapabilityResult{}
				if err == nil {
					result.Value, _, err = projectResult(value, DefaultLimits().ResultBytes)
				} else if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					result.BusinessError = &Failure{Code: "tool-failed", Message: "工具执行失败，请检查对应域状态"}
					err = nil
				}
				return result, err
			}
			if c.Source == "wiki" {
				if err := tools.ConsumeBackend(ctx, o.DispatchID); err != nil {
					return nil, err
				}
				run, err := m.store.get(ctx, o.RunID)
				if err != nil {
					return nil, err
				}
				return m.executeWikiOperation(ctx, run, o)
			}
			if m.deps.Catalog == nil {
				return nil, bad("capability-unavailable", "扩展能力不可用")
			}
			if err := m.deps.Catalog.Check(ctx, s, o); err != nil {
				return nil, err
			}
			if err := tools.Revalidate(ctx); err != nil {
				return nil, err
			}
			if extension, ok := m.deps.Catalog.(*Extensions); ok {
				return extension.executeBackend(ctx, s, o)
			}
			return m.deps.Catalog.Execute(ctx, s, o)
		}})
	}
	return m.toolRuntime.RegisterCatalog(s.Digest, descriptors)
}

func (m *Manager) executeRegistryOperation(ctx context.Context, s CapabilitySnapshot, o Operation, limit int) (finalResult CapabilityResult, finalErr error) {
	if o.Capability.Source == "builtin" && o.Capability.CatalogDigest != "" {
		matched := false
		if m.deps.Tools != nil {
			for _, schema := range m.deps.Tools.Schemas() {
				if schema.Name == o.Capability.Name && (digestJSON(schema) == o.Capability.CatalogDigest || legacyFileCatalogCompatible(s, o, schema)) {
					matched = true
				}
			}
		}
		if !matched {
			return CapabilityResult{}, bad("tool-catalog-changed", "平台工具版本与本轮固定目录不符")
		}
	}
	if err := m.registerRunCatalog(s); err != nil {
		return CapabilityResult{}, err
	}
	defer func() { finalErr = errors.Join(finalErr, m.toolRuntime.ReleaseCatalog(s.Digest)) }()
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return CapabilityResult{}, err
	}
	value, err := m.toolRuntime.Execute(ctx, o.Capability.Name, args)
	if err != nil {
		if result, ok := value.(CapabilityResult); ok {
			return result, err
		}
		if o.Capability.Metadata.Async {
			return CapabilityResult{Unknown: true}, err
		}
		return CapabilityResult{}, err
	}
	if submitted, ok := value.(tools.Submission); ok {
		if !o.Capability.Metadata.Async || submitted.Task.ID == "" || submitted.Task.Domain == "" || submitted.Task.RequestID == "" {
			return CapabilityResult{Unknown: true}, bad("invalid-task-reference", "异步提交缺少可恢复的任务身份")
		}
		if expected := o.Task; expected != nil && (expected.Domain != submitted.Task.Domain || expected.ID != "" && expected.ID != submitted.Task.ID || expected.RequestID != "" && expected.RequestID != submitted.Task.RequestID) {
			return CapabilityResult{Unknown: true}, bad("task-identity-changed", "提交回执与固定任务身份不符")
		}
		raw, _, err := projectResult(submitted.Value, limit)
		return CapabilityResult{Value: raw, Task: &submitted.Task}, err
	}
	if o.Capability.Metadata.Async {
		return CapabilityResult{Unknown: true}, bad("invalid-task-reference", "异步工具未返回可恢复的接受回执")
	}
	if result, ok := value.(CapabilityResult); ok {
		return result, nil
	}
	if o.Capability.Source != "builtin" {
		return CapabilityResult{}, errors.New("工具结果类型无效")
	}
	raw, _, err := projectResult(value, limit)
	return CapabilityResult{Value: raw}, err
}
