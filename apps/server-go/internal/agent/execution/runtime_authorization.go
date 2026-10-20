package execution

import (
	"context"
	"reflect"
	"strings"

	"elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
)

// RuntimeAuthorization is supplied only through a host-owned callback. It is
// never accepted from a model, a server configuration, or a plain context key.
type RuntimeAuthorization struct {
	ID             string         `json:"id"`
	DispatchID     string         `json:"dispatchId"`
	ScopeID        string         `json:"scopeId"`
	Profile        config.Profile `json:"profile"`
	Grant          *config.Grant  `json:"grant,omitempty"`
	ServerID       string         `json:"serverId,omitempty"`
	ServerRevision int            `json:"serverRevision,omitempty"`
	CatalogDigest  string         `json:"catalogDigest,omitempty"`
	Platform       string         `json:"platform,omitempty"`
	Command        []string       `json:"command"`
}

func RuntimeGrant(id string, scope config.AccessScope) config.Grant {
	s := config.CloneAccessScope(&scope)
	return config.Grant{ID: "authorization-" + id, Revision: 1, Enabled: true, Name: "运行时授权", Directories: s.Directories, Network: s.Network, PrivateCIDRs: s.PrivateCIDRs}
}

func (e *Executor) runtimeAuthorization(ctx context.Context, dispatch string) (*RuntimeAuthorization, error) {
	if e.options.ResolveRuntimeAuthorization == nil {
		return nil, nil
	}
	a, err := e.options.ResolveRuntimeAuthorization(ctx, dispatch)
	if err != nil {
		return nil, problem(403, "execution-runtime-authorization", "运行时授权无法验证")
	}
	if a == nil {
		return nil, nil
	}
	if !identityPattern.MatchString(a.ID) || dispatch == "" || a.DispatchID != dispatch || !identityPattern.MatchString(a.ScopeID) {
		return nil, problem(403, "execution-runtime-authorization", "运行时授权与当前派发身份不符")
	}
	return a, nil
}

func validateRuntimeBinding(a *RuntimeAuthorization, ctx context.Context, id string, p config.Profile, grant *config.Grant, start frame) error {
	if a == nil {
		if strings.HasPrefix(p.ID, "runtime-") || grant != nil && strings.HasPrefix(grant.ID, "authorization-") {
			return problem(403, "execution-runtime-authorization", "运行时环境和权限必须绑定已确认的单次派发")
		}
		return nil
	}
	if a.ScopeID != id || !reflect.DeepEqual(a.Profile, p) || !reflect.DeepEqual(a.Grant, grant) || len(a.Command) == 0 || !reflect.DeepEqual(a.Command, start.Command) || a.ServerID != start.serverID || a.ServerRevision != start.serverRevision {
		return problem(403, "execution-runtime-authorization", "执行参数与已确认运行时授权不符")
	}
	if start.serverID != "" && (mcp.Scope(ctx) != a.ScopeID || a.CatalogDigest == "") {
		return problem(403, "execution-runtime-authorization", "MCP 运行授权缺少匹配操作范围和目录摘要")
	}
	if strings.HasPrefix(p.ID, "runtime-") {
		if p.ID != "runtime-bash" && p.ID != "runtime-python" && p.ID != "runtime-node" && p.ID != "runtime-mcp" || p.Revision != 1 {
			return problem(403, "execution-runtime-authorization", "运行时环境身份无效")
		}
	} else if p.ID == "" {
		return problem(403, "execution-runtime-authorization", "运行时环境必须具有显式身份")
	}
	if grant != nil && strings.HasPrefix(grant.ID, "authorization-") && (grant.ID != "authorization-"+a.ID || grant.Revision != 1) {
		return problem(403, "execution-runtime-authorization", "临时授权没有绑定当前确认事实")
	}
	if grant != nil && grant.ID == "" {
		return problem(403, "execution-runtime-authorization", "运行时权限必须具有显式身份")
	}
	return nil
}

// ValidateRuntimeAccess is a read-only preflight; start always repeats it.
func (e *Executor) ValidateRuntimeAccess(scope config.AccessScope) error {
	grant := RuntimeGrant("preflight", scope)
	_, err := e.binds(&grant)
	return err
}

func (e *Executor) RevokeRuntimeAuthorization(ctx context.Context, id string) error {
	e.mu.Lock()
	e.recordRevocation("authorization:"+id, 0)
	var matches []*Process
	for _, p := range e.active {
		if p.authorizationID == id {
			matches = append(matches, p)
		}
	}
	e.mu.Unlock()
	var first error
	for _, p := range matches {
		if err := p.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (e *Executor) runtimeAuthorizationRevoked(a *RuntimeAuthorization) bool {
	return a != nil && e.revoked["authorization:"+a.ID][0]
}
