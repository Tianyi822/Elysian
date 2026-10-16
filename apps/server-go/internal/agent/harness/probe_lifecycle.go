package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

// Administrative probes have no Run or model approval, but starting a stdio
// server is still external execution. Its durable scope is the executor label
// identity even if a crash happens before Docker returns a container ID.
func (m *Manager) probeServer(ctx context.Context, e *Extensions, server mcp.Server) (mcp.Catalog, error) {
	m.mu.Lock()
	if err := m.checkProbeLocked(ctx, server); err != nil {
		m.mu.Unlock()
		return mcp.Catalog{}, err
	}
	lease := ResourceLease{ID: "probe-" + m.deps.NewID(), Source: "mcp-probe", ServerID: server.ID, ServerRevision: server.Revision,
		State: "held", Claims: []ResourceClaim{{Kind: "global", Authority: "external", Key: "*", Access: "write"}}, CreatedAt: stamp(m.deps.Now())}
	lease.ScopeID = lease.ID
	err := m.store.write(ctx, "probe-start", func(tx *sql.Tx) error {
		if err := saveResourceLease(ctx, tx, lease); err != nil {
			return err
		}
		available, err := resourceLeaseAvailable(ctx, tx, Operation{Capability: Capability{Source: "mcp-probe"}}, lease)
		if err != nil {
			return err
		}
		if !available {
			return &Error{409, "resource-busy", "存在冲突执行或未核实的执行结果，暂不能启动 MCP 探测"}
		}
		return nil
	})
	if err != nil {
		m.mu.Unlock()
		return mcp.Catalog{}, storageFailure(err)
	}
	m.probes.Add(1) // Serialized with Close setting closed before Wait.
	m.mu.Unlock()
	defer m.probes.Done()

	pctx, cancel := context.WithTimeout(mcp.WithScope(ctx, lease.ScopeID), 60*time.Second)
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	defer cancel()
	var catalog mcp.Catalog
	probeErr := m.store.recordsFault()
	if probeErr == nil {
		catalog, probeErr = m.executeProbe(pctx, e, server, lease)
	}
	lease.ContainerID = e.MCP.StdioIdentity(pctx, server.ID, server.Revision)
	closeCtx, closeCancel := context.WithTimeout(mcp.WithScope(context.Background(), lease.ScopeID), 5*time.Second)
	closeErr := e.MCP.CloseServer(closeCtx, server.ID, server.Revision)
	closeCancel()
	unknown := closeErr != nil
	// Startup may fail after allocating a container but before publishing its
	// pipe to the MCP client. A missing connection is not proof of cleanup.
	var execErr *execution.Error
	var mcpErr *mcp.Error
	if errors.As(probeErr, &execErr) && execErr.OutcomeUnknown || errors.As(probeErr, &mcpErr) && mcpErr.Code == "mcp-close-unconfirmed" {
		unknown = true
	}
	m.mu.Lock()
	settleCtx, settleCancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = m.store.write(settleCtx, "probe-stop", func(tx *sql.Tx) error {
		lease.State = "released"
		lease.EndedAt = stamp(m.deps.Now())
		if unknown {
			lease.State = "unknown"
			lease.EndedAt = ""
		}
		return saveResourceLease(settleCtx, tx, lease)
	})
	settleCancel()
	if err != nil {
		m.storageFailedLocked()
	}
	m.mu.Unlock()
	m.signal()
	if err != nil {
		return mcp.Catalog{}, storageFailure(err)
	}
	if unknown {
		return mcp.Catalog{}, &Error{503, "mcp-probe-stop-unconfirmed", "MCP 探测容器停止结果未确认；资源租约保持未知，须核实容器后解除"}
	}
	if probeErr != nil {
		return mcp.Catalog{}, probeErr
	}
	if err = m.checkProbe(ctx, server); err != nil {
		return mcp.Catalog{}, err
	}
	return e.Servers.SaveCatalog(server.ID, server.Revision, catalog)
}

func (m *Manager) executeProbe(ctx context.Context, e *Extensions, server mcp.Server, lease ResourceLease) (catalog mcp.Catalog, resultErr error) {
	const name = "mcp_admin_probe"
	args := tools.Arguments{"serverId": server.ID, "revision": server.Revision}
	descriptor := tools.Descriptor{Name: name, Description: "管理员显式探测固定 MCP 服务目录", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"serverId", "revision"}, Properties: map[string]tools.Schema{"serverId": {Type: tools.SchemaString}, "revision": {Type: tools.SchemaInteger}}}, Metadata: tools.Metadata{Domain: "mcp", Action: "probe", Effect: "execute", Exposure: "admin", Backend: "mcp", Version: "1"}, Handler: func(access *kardia.Context, _ tools.Arguments) (any, error) {
		callCtx := tools.Lifetime(access)
		if server.Stdio == nil {
			if err := tools.ConsumeBackend(callCtx, lease.ID); err != nil {
				return nil, err
			}
		}
		return e.MCP.Probe(callCtx, server)
	}}
	if err := m.toolRuntime.RegisterCatalog(lease.ID, []tools.Descriptor{descriptor}); err != nil {
		return catalog, err
	}
	defer func() { resultErr = errors.Join(resultErr, m.toolRuntime.ReleaseCatalog(lease.ID)) }()
	authorized, err := m.toolAuthority.Authorize(ctx, tools.AuthorizationBinding{OperationID: lease.ID, DispatchID: lease.ID, Tool: name, ArgumentsDigest: tools.ArgumentsDigest(args), CatalogID: lease.ID}, nil, func(checkCtx context.Context) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if err := m.checkProbeLocked(checkCtx, server); err != nil {
			return err
		}
		var raw string
		if err := m.store.db.QueryRowContext(checkCtx, "SELECT document FROM resource_leases WHERE id=?", lease.ID).Scan(&raw); err != nil {
			return err
		}
		var stored ResourceLease
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return err
		}
		if stored.State != "held" || digestJSON(stored) != digestJSON(lease) {
			return bad("probe-lease-changed", "MCP 探测授权与持久化租约不符")
		}
		return nil
	})
	if err != nil {
		return catalog, err
	}
	value, err := m.toolRuntime.Execute(authorized, name, args)
	if err != nil {
		return catalog, err
	}
	var ok bool
	if catalog, ok = value.(mcp.Catalog); !ok {
		return catalog, bad("invalid-probe-result", "MCP 探测结果类型无效")
	}
	return catalog, nil
}

// ReconcileProbeLease only releases administrator probe leases. Run operations
// must continue through their execution barrier so both records stay atomic.
func (m *Manager) ReconcileProbeLease(ctx context.Context, id, evidence, decision string) (ResourceLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var lease ResourceLease
	if m.closed {
		return lease, closedError()
	}
	if strings.TrimSpace(evidence) == "" || len(evidence) > 8192 || decision != "confirmed-stopped" {
		return lease, bad("invalid-reconciliation", "探测租约核实必须提供外部停止证据与 confirmed-stopped 决定")
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return lease, err
		}
	}
	err := m.store.write(ctx, "probe-reconcile", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", id).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &lease); err != nil {
			return err
		}
		if lease.Source != "mcp-probe" || lease.OperationID != "" || lease.RunID != "" {
			return &Error{409, "lease-reconciliation-denied", "操作租约须通过对应执行屏障核实"}
		}
		if lease.State == "released" && lease.Evidence == evidence && lease.Decision == decision {
			return nil
		}
		if lease.State != "unknown" {
			return &Error{409, "lease-state-conflict", "只能核实停止结果未知的探测租约"}
		}
		lease.State = "released"
		lease.EndedAt = stamp(m.deps.Now())
		lease.Evidence, lease.Decision = evidence, decision
		return saveResourceLease(ctx, tx, lease)
	})
	if err == nil {
		m.signal()
	}
	return lease, storageFailure(err)
}
