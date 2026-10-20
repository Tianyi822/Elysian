package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// ProbeAccessRequest lives in the existing lease document and JSONL ledger.
// Pending requests hold no resources. Accepting one atomically claims its
// unique lease, so a retry or a restart can never launch a second probe.
type ProbeAccessRequest struct {
	ID                string                        `json:"id"`
	Version           int                           `json:"version"`
	RequestID         string                        `json:"requestId"`
	ServerID          string                        `json:"serverId"`
	ServerRevision    int                           `json:"serverRevision"`
	ServerName        string                        `json:"serverName"`
	State             string                        `json:"state"`
	Digest            string                        `json:"digest"`
	CreatedAt         string                        `json:"createdAt"`
	Access            AccessRequest                 `json:"access"`
	Command           []string                      `json:"command"`
	Environment       *execution.RuntimeEnvironment `json:"environment,omitempty"`
	Progress          *execution.RuntimeProgress    `json:"progress,omitempty"`
	Error             string                        `json:"error,omitempty"`
	Catalog           *mcpCatalogProjection         `json:"catalog,omitempty"`
	DecisionRequestID string                        `json:"decisionRequestId,omitempty"`
	Decision          string                        `json:"decision,omitempty"`
	CancelRequestID   string                        `json:"cancelRequestId,omitempty"`
}

type ProbeAccessDecision struct {
	RequestID       string `json:"requestId"`
	ExpectedVersion int    `json:"expectedVersion"`
	ExpectedDigest  string `json:"expectedDigest"`
	Decision        string `json:"decision"`
}

func validProbeRequestID(id string) bool {
	return strings.TrimSpace(id) == id && id != "" && len(id) <= 128 && !strings.ContainsAny(id, "\x00\n\r")
}

func readProbeLease(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (ResourceLease, error) {
	var lease ResourceLease
	var raw string
	if err := db.QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lease, &Error{404, "probe-request-not-found", "MCP 探测申请不存在"}
		}
		return lease, storageFailure(err)
	}
	if err := json.Unmarshal([]byte(raw), &lease); err != nil {
		return lease, storageFailure(err)
	}
	if lease.Source != "mcp-probe" || lease.Probe == nil {
		return lease, &Error{404, "probe-request-not-found", "MCP 探测申请不存在"}
	}
	if lease.State == "unknown" {
		lease.Probe.State = "unknown"
		lease.Probe.Error = "探测结果未确认，需要先核实已有执行"
	}
	return lease, nil
}

func (m *Manager) ProbeAccess(ctx context.Context, id string) (ProbeAccessRequest, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ProbeAccessRequest{}, closedError()
	}
	lease, err := readProbeLease(ctx, m.store.db, id)
	if err != nil {
		return ProbeAccessRequest{}, err
	}
	return *lease.Probe, nil
}

func (m *Manager) RequestProbeAccess(ctx context.Context, e *Extensions, server mcp.Server, requestID string) (ProbeAccessRequest, error) {
	var result ProbeAccessRequest
	if !validProbeRequestID(requestID) {
		return result, bad("invalid-request-id", "探测申请需要有效请求编号")
	}
	if server.Stdio == nil || e.Executor == nil || e.MCP == nil {
		return result, bad("probe-runtime-unavailable", "容器探测或受管执行器不可用")
	}
	if err := m.checkRuntimeProbe(ctx, server); err != nil {
		return result, err
	}
	// First return exact earlier request, without consulting mutable image tags
	// or trying the registry again after an unknown HTTP response.
	if found, err := m.findProbeRequest(ctx, server.ID, server.Revision, requestID); err != nil || found != nil {
		if found != nil {
			return *found, err
		}
		return result, err
	}
	env, err := e.Executor.ResolveMCPRuntime(ctx, server.Stdio.Image)
	if err != nil {
		return result, err
	}
	scope := execconfig.AccessScope{Directories: []execconfig.Directory{}, Network: []execconfig.NetworkEndpoint{}, PrivateCIDRs: []string{}}
	if server.Stdio.RequestedAccess != nil {
		scope = *execconfig.CloneAccessScope(server.Stdio.RequestedAccess)
	}
	if server.Stdio.GrantID != "" {
		if e.Config == nil {
			return result, bad("execution-unavailable", "旧 MCP 授权配置不可用")
		}
		grant, err := e.Config.GetGrant(server.Stdio.GrantID, server.Stdio.GrantRevision, true)
		if err != nil {
			return result, err
		}
		scope = execconfig.AccessScope{Directories: grant.Directories, Network: grant.Network, PrivateCIDRs: grant.PrivateCIDRs}
	}
	if err := e.Executor.ValidateRuntimeAccess(scope); err != nil {
		return result, err
	}
	env.Profile.TimeoutSeconds = 60
	env.Profile.Command = append([]string{}, server.Stdio.Command...)
	id := "probe-" + m.deps.NewID()
	result = ProbeAccessRequest{ID: id, Version: 1, RequestID: requestID, ServerID: server.ID, ServerRevision: server.Revision, ServerName: server.Name, State: "waiting", CreatedAt: stamp(m.deps.Now()), Command: append([]string{}, server.Stdio.Command...), Environment: &env,
		Access: AccessRequest{Revision: 1, Kind: "mcp", Directories: scope.Directories, Network: scope.Network, PrivateCIDRs: scope.PrivateCIDRs, Resources: []execconfig.Resource{}, SessionAllowed: false,
			Runtime: &AccessRuntime{Name: env.Profile.Name, Image: env.Profile.Image, Platform: env.Platform, RequiresDownload: env.RequiresDownload}, Reason: "仅允许这次目录探测；完成后关闭 MCP 容器"}}
	result.Digest = digestJSON(struct {
		Server  mcp.Server
		Request ProbeAccessRequest
	}{server.Public(), result})
	result.Access.Digest, result.Access.ScopeKey = result.Digest, result.Digest
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.checkRuntimeProbeLocked(ctx, server); err != nil {
		return ProbeAccessRequest{}, err
	}
	err = m.store.write(ctx, "probe-access-request", func(tx *sql.Tx) error {
		prior, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE run_id='' AND operation_id=''")
		if err != nil {
			return err
		}
		pending := 0
		for _, lease := range prior {
			if lease.Probe != nil && lease.Probe.RequestID == requestID {
				if lease.ServerID != server.ID || lease.ServerRevision != server.Revision {
					return &Error{409, "probe-request-conflict", "探测请求编号已用于另一服务修订"}
				}
				result = *lease.Probe
				return nil
			}
			if lease.State == "awaiting-approval" {
				pending++
			}
		}
		if pending >= 64 {
			return &Error{429, "probe-request-limit", "等待确认的 MCP 探测达到上限，请先处理已有申请"}
		}
		lease := ResourceLease{ID: id, Source: "mcp-probe", ServerID: server.ID, ServerRevision: server.Revision, ScopeID: id, State: "awaiting-approval", CreatedAt: result.CreatedAt, Claims: []ResourceClaim{{Kind: "global", Authority: "external", Key: "*", Access: "write"}}, Probe: &result}
		return saveResourceLease(ctx, tx, lease)
	})
	return result, storageFailure(err)
}

func (m *Manager) findProbeRequest(ctx context.Context, serverID string, revision int, requestID string) (*ProbeAccessRequest, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	leases, err := readDocuments[ResourceLease](ctx, m.store.db, "SELECT document FROM resource_leases WHERE run_id='' AND operation_id=''")
	if err != nil {
		return nil, storageFailure(err)
	}
	for _, lease := range leases {
		if lease.Probe != nil && lease.Probe.RequestID == requestID {
			if lease.ServerID != serverID || lease.ServerRevision != revision {
				return nil, &Error{409, "probe-request-conflict", "探测请求编号已用于另一服务修订"}
			}
			return lease.Probe, nil
		}
	}
	return nil, nil
}

func (m *Manager) DecideProbeAccess(ctx context.Context, e *Extensions, id string, in ProbeAccessDecision) (ProbeAccessRequest, error) {
	var result ProbeAccessRequest
	if !validProbeRequestID(in.RequestID) || (in.Decision != "allow-once" && in.Decision != "deny") {
		return result, bad("invalid-probe-decision", "探测只能仅本次允许或拒绝，并须提供请求编号")
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return result, closedError()
	}
	lease, err := readProbeLease(ctx, m.store.db, id)
	if err != nil {
		m.mu.Unlock()
		return result, err
	}
	server, err := e.Servers.Resolve(lease.ServerID, lease.ServerRevision, false)
	if err != nil {
		m.mu.Unlock()
		return result, err
	}
	if err = m.checkRuntimeProbeLocked(ctx, server); err != nil {
		m.mu.Unlock()
		return result, err
	}
	start := false
	err = m.store.write(ctx, "probe-access-decision", func(tx *sql.Tx) error {
		var err error
		lease, err = readProbeLease(ctx, tx, id)
		if err != nil {
			return err
		}
		p := lease.Probe
		if in.ExpectedVersion != p.Version || in.ExpectedDigest != p.Digest {
			return &Error{409, "probe-request-changed", "MCP 探测申请已变化，请重新读取"}
		}
		if p.DecisionRequestID != "" {
			if p.DecisionRequestID == in.RequestID && p.Decision == in.Decision {
				return nil
			}
			return &Error{409, "probe-decision-conflict", "MCP 探测申请已经决定"}
		}
		if p.State != "waiting" || lease.State != "awaiting-approval" {
			return &Error{409, "probe-state-conflict", "MCP 探测申请不再等待确认"}
		}
		p.DecisionRequestID, p.Decision = in.RequestID, in.Decision
		if in.Decision == "deny" {
			p.State = "denied"
			lease.State = "released"
			lease.EndedAt = stamp(m.deps.Now())
		} else {
			available, err := resourceLeaseAvailable(ctx, tx, Operation{Capability: Capability{Source: "mcp-probe"}}, lease)
			if err != nil {
				return err
			}
			if !available {
				return &Error{409, "resource-busy", "存在冲突执行或未核实结果，暂不能启动 MCP 探测"}
			}
			p.State = "preparing"
			lease.State = "held"
			start = true
		}
		return saveResourceLease(ctx, tx, lease)
	})
	if err != nil {
		m.mu.Unlock()
		return result, storageFailure(err)
	}
	result = *lease.Probe
	if start {
		pctx, cancel := context.WithCancel(m.ctx)
		if m.probeCancels == nil {
			m.probeCancels = map[string]context.CancelFunc{}
		}
		m.probeCancels[id] = cancel
		m.probes.Add(1)
		go m.runAuthorizedProbe(pctx, cancel, e, server, lease)
	}
	m.mu.Unlock()
	return result, nil
}

func (m *Manager) runAuthorizedProbe(ctx context.Context, cancel context.CancelFunc, e *Extensions, server mcp.Server, lease ResourceLease) {
	defer m.probes.Done()
	defer cancel()
	defer func() { m.mu.Lock(); delete(m.probeCancels, lease.ID); m.mu.Unlock() }()
	prepared := false
	var lastReport time.Time
	err := e.Executor.EnsureRuntime(ctx, *lease.Probe.Environment, func(p execution.RuntimeProgress) error {
		if p.State != "ready" && time.Since(lastReport) < 250*time.Millisecond {
			return ctx.Err()
		}
		lastReport = time.Now()
		m.mu.Lock()
		defer m.mu.Unlock()
		if err := m.store.recordsFault(); err != nil {
			return err
		}
		err := m.store.write(ctx, "probe-runtime-progress", func(tx *sql.Tx) error {
			stored, err := readProbeLease(ctx, tx, lease.ID)
			if err != nil {
				return err
			}
			if stored.Probe.State == "cancelled" {
				return context.Canceled
			}
			lease.Probe.Progress = &p
			if p.State == "ready" {
				lease.Probe.State = "running"
			}
			return saveResourceLease(ctx, tx, lease)
		})
		if err != nil {
			return err
		}
		return m.store.recordsFault()
	})
	var catalog mcp.Catalog
	if err == nil {
		prepared = true
		catalog, err = m.runProbe(ctx, e, server, lease)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	settleCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	writeErr := m.store.write(settleCtx, "probe-access-result", func(tx *sql.Tx) error {
		stored, readErr := readProbeLease(settleCtx, tx, lease.ID)
		if readErr != nil {
			return readErr
		}
		if !prepared {
			stored.State = "released"
			stored.EndedAt = stamp(m.deps.Now())
			stored.Probe.State = "failed"
			stored.Probe.Error = "MCP 运行镜像准备失败"
			var execErr *execution.Error
			if errors.As(err, &execErr) && execErr.OutcomeUnknown {
				stored.State = "unknown"
				stored.EndedAt = ""
				stored.Probe.State = "unknown"
				stored.Probe.Error = "MCP 运行镜像准备结果未确认，须先核实"
			}
		}
		if ctx.Err() != nil && stored.State != "unknown" {
			stored.Probe.State = "cancelled"
			stored.Probe.Error = "MCP 探测已取消"
		}
		if err == nil {
			projected := publicMCPCatalog(server.ID, catalog)
			stored.Probe.Catalog = &projected
			stored.Probe.State = "completed"
			stored.Probe.Error = ""
		} else if stored.State != "unknown" && stored.Probe.State != "cancelled" {
			stored.Probe.State = "failed"
			stored.Probe.Error = "MCP 探测或镜像准备失败"
		}
		return saveResourceLease(settleCtx, tx, stored)
	})
	if writeErr != nil {
		m.storageFailedLocked()
	}
	m.signal()
}

func (m *Manager) CancelProbeAccess(ctx context.Context, id, requestID string) (ProbeAccessRequest, error) {
	var result ProbeAccessRequest
	if !validProbeRequestID(requestID) {
		return result, bad("invalid-request-id", "取消探测需要有效请求编号")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return result, closedError()
	}
	err := m.store.write(ctx, "probe-access-cancel", func(tx *sql.Tx) error {
		lease, err := readProbeLease(ctx, tx, id)
		if err != nil {
			return err
		}
		p := lease.Probe
		if p.CancelRequestID != "" {
			if p.CancelRequestID != requestID {
				return &Error{409, "probe-cancel-conflict", "探测已经由另一请求取消"}
			}
			result = *p
			return nil
		}
		if p.State != "waiting" && p.State != "preparing" && p.State != "running" {
			return &Error{409, "probe-state-conflict", "MCP 探测已结束或结果未知"}
		}
		p.CancelRequestID = requestID
		p.State = "cancelled"
		if lease.State == "awaiting-approval" {
			lease.State = "released"
			lease.EndedAt = stamp(m.deps.Now())
		}
		result = *p
		return saveResourceLease(ctx, tx, lease)
	})
	if err == nil {
		if cancel := m.probeCancels[id]; cancel != nil {
			cancel()
		}
	}
	return result, storageFailure(err)
}

type probeExecutionPayload struct{ Lease ResourceLease }

func probeAuthorizationPayload(lease ResourceLease) any {
	if lease.Probe == nil {
		return nil
	}
	return probeExecutionPayload{Lease: lease}
}
func probeRuntimeExecutionAuthorization(ctx context.Context, dispatchID string) (*execution.RuntimeAuthorization, error) {
	payload, ok := tools.Payload(ctx).(probeExecutionPayload)
	if !ok {
		return nil, nil
	}
	l := payload.Lease
	if dispatchID == "" || tools.DispatchID(ctx) != dispatchID || l.ID != dispatchID || l.State != "held" || l.Probe == nil || l.Probe.Decision != "allow-once" || l.Probe.Environment == nil {
		return nil, bad("probe-authorization-invalid", "MCP 探测执行缺少匹配的确认事实")
	}
	if err := tools.Revalidate(ctx); err != nil {
		return nil, err
	}
	a := l.Probe.Access
	grant := execution.RuntimeGrant(l.ID, execconfig.AccessScope{Directories: a.Directories, Network: a.Network, PrivateCIDRs: a.PrivateCIDRs})
	return &execution.RuntimeAuthorization{ID: l.ID, DispatchID: dispatchID, ScopeID: l.ScopeID, Profile: l.Probe.Environment.Profile, Grant: &grant, ServerID: l.ServerID, ServerRevision: l.ServerRevision, CatalogDigest: l.Probe.Digest, Platform: l.Probe.Environment.Platform, Command: append([]string{}, l.Probe.Command...)}, nil
}

// The new confirmation creates its own exact authority. A legacy grant is only
// the proposal's source; server revision and persistent MCP revocation gates
// still apply to every confirmed operation.
func (m *Manager) checkRuntimeProbeLocked(ctx context.Context, server mcp.Server) error {
	if server.Stdio != nil {
		copy := *server.Stdio
		copy.GrantID = ""
		copy.GrantRevision = 0
		server.Stdio = &copy
	}
	return m.checkProbeLocked(ctx, server)
}
func (m *Manager) checkRuntimeProbe(ctx context.Context, server mcp.Server) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.checkRuntimeProbeLocked(ctx, server)
}
