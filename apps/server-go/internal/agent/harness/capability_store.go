package harness

import (
	"context"
	"crypto/sha256"
	"database/sql"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/tools"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"
)

func digestJSON(v any) string {
	b, _ := json.Marshal(v)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
func nextSeq(s string) string { n, _ := strconv.ParseInt(s, 10, 64); return strconv.FormatInt(n+1, 10) }
func (m *Manager) environment(ctx context.Context, id string) (Environment, error) {
	var raw string
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM environments WHERE session_id=? ORDER BY revision DESC LIMIT 1", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		names := []string{}
		if m.deps.Tools != nil {
			for _, schema := range m.deps.Tools.Schemas() {
				if allowed(schema.Name) || schema.Metadata.Exposure == "agent" {
					names = append(names, schema.Name)
				}
			}
		}
		if len(names) == 0 && m.deps.Tools != nil {
			names = []string{"docker_containers_list", "docker_images_list", "docker_policy_view", "docker_self_container"}
		}
		if m.deps.Workspaces != nil {
			names = append(names, TaskWorkspaceList, TaskWorkspaceRead, TaskWorkspaceWrite, TaskWorkspaceCopy, TaskWorkspaceMove, TaskWorkspaceDelete)
		}
		return Environment{SessionID: id, Skills: []RevisionRef{}, Servers: []RevisionRef{}, Tools: names, Resources: []ResourceRef{}, ExecutionProfiles: []RevisionRef{}, Grants: []RevisionRef{}, TrustedReadOnly: []string{}}, nil
	}
	var e Environment
	if err == nil {
		err = json.Unmarshal([]byte(raw), &e)
	}
	return e, err
}
func (m *Manager) GetEnvironment(ctx context.Context, id string) (Environment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Environment{}, closedError()
	}
	if _, err := readSession(ctx, m.store.db, id); err != nil {
		return Environment{}, storageFailure(err)
	}
	e, err := m.environment(ctx, id)
	return e, storageFailure(err)
}
func (m *Manager) PutEnvironment(ctx context.Context, id string, expected int, e Environment) (Environment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return e, closedError()
	}
	session, err := readSession(ctx, m.store.db, id)
	if err != nil {
		return e, storageFailure(err)
	}
	if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		return e, &Error{409, "session-busy", "会话忙碌时不能修改环境"}
	}
	old, err := m.environment(ctx, id)
	if err != nil {
		return e, storageFailure(err)
	}
	if old.Revision != expected {
		return e, &Error{409, "revision-conflict", "会话环境版本已变化"}
	}
	e.SessionID = id
	e.Revision = expected + 1
	fixed, err := m.snapshot(ctx, e)
	if err != nil {
		return e, err
	}
	e = fixed.Environment
	raw, _ := json.Marshal(e)
	err = m.store.write(ctx, "environment", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO environments(session_id,revision,document) VALUES(?,?,?)", id, e.Revision, string(raw))
		return err
	})
	return e, storageFailure(err)
}
func (m *Manager) snapshot(ctx context.Context, e Environment) (CapabilitySnapshot, error) {
	var s CapabilitySnapshot
	var err error
	if m.deps.Catalog != nil {
		s, err = m.deps.Catalog.Snapshot(ctx, e)
		if err != nil {
			return s, err
		}
	} else if len(e.Skills)+len(e.Servers)+len(e.ExecutionProfiles)+len(e.Grants) > 0 {
		return s, bad("capability-unavailable", "扩展能力尚未配置")
	}
	s.Environment = e
	if len(e.ResourceRules) > 128 {
		return s, bad("environment-limit", "资源规则不能超过 128 条")
	}
	ruleIDs := map[string]bool{}
	s.ResourceRules = nil
	s.Environment.ResourceRules = append([]RevisionRef(nil), e.ResourceRules...)
	for i, ref := range e.ResourceRules {
		if !requestPattern.MatchString(ref.ID) || ref.Revision < 1 || ruleIDs[ref.ID] {
			return s, bad("invalid-resource-rule", "资源规则必须唯一且固定具体修订")
		}
		ruleIDs[ref.ID] = true
		rule, readErr := readResourceRule(ctx, m.store.db, ref.ID, ref.Revision)
		if readErr != nil {
			return s, storageFailure(readErr)
		}
		latest, readErr := readResourceRule(ctx, m.store.db, ref.ID, 0)
		if readErr != nil {
			return s, storageFailure(readErr)
		}
		if !rule.Enabled || !latest.Enabled || (ref.Digest != "" && ref.Digest != rule.Digest) {
			return s, bad("resource-rule-disabled", "资源规则已停用或摘要不符")
		}
		s.ResourceRules = append(s.ResourceRules, rule)
		s.Environment.ResourceRules[i].Digest = rule.Digest
	}
	if m.deps.Tools != nil {
		for _, t := range m.deps.Tools.Schemas() {
			for _, name := range e.Tools {
				if name == t.Name && (allowed(name) || t.Metadata.Exposure == "agent") {
					raw, _ := json.Marshal(t.Parameters)
					s.Tools = append(s.Tools, Capability{Name: name, Description: t.Description, Parameters: raw, Source: "builtin", ReadOnly: t.Metadata.ReadOnly || allowed(name), Metadata: t.Metadata, CatalogDigest: digestJSON(t)})
				}
			}
		}
	}
	// Task workspace capabilities are supplied by the harness itself rather
	// than the Docker bridge. The environment still explicitly selects them so
	// the immutable capability snapshot records the user's choice.
	for _, name := range e.Tools {
		if capability, ok := taskWorkspaceCapability(name); ok {
			if m.deps.Workspaces == nil {
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
	seen := map[string]bool{}
	spaces, e2 := m.wikiSessionSpacesLocked(ctx, e.SessionID)
	if e2 != nil {
		return s, e2
	}
	if len(spaces) > 0 {
		s.Tools = append(s.Tools, wikiCapabilities()...)
	}
	for _, c := range s.Materials {
		if c.Name == toolSearchName || c.Source == toolDiscoverySource || c.Name == userInputTool || c.Source == userInputSource || c.Name == planTool || c.Source == planSource {
			return s, bad("reserved-capability", "资料目录使用了内核保留的工具名称或来源")
		}
	}
	for _, c := range s.Tools {
		if c.Name == toolSearchName || c.Source == toolDiscoverySource || c.Name == userInputTool || c.Source == userInputSource || c.Name == planTool || c.Source == planSource {
			return s, bad("reserved-capability", "工具目录使用了内核保留的工具名称或来源")
		}
		if seen[c.Name] {
			return s, bad("duplicate-capability", "能力别名重复")
		}
		seen[c.Name] = true
	}
	if len(s.Tools) > maxDiscoveryCatalog {
		return s, bad("capability-limit", "运行固定工具目录不能超过 512 项，请减少执行范围后重试")
	}
	s.ToolLoading = ""
	if len(s.Tools) > eagerToolLimit {
		s.ToolLoading = onDemandTools
		s.Tools = append(s.Tools, toolSearchCapability())
	}
	s.Digest = ""
	s.Digest = digestJSON(s)
	return s, nil
}
func saveOperation(ctx context.Context, tx *sql.Tx, o Operation) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO operations(id,run_id,model_request_id,call_index,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, o.ID, o.RunID, o.ModelRequestID, o.CallIndex, o.Status, string(raw))
	return err
}
func readOperation(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (Operation, error) {
	var o Operation
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM operations WHERE id=?", id).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &o)
	}
	return o, err
}
func saveApproval(ctx context.Context, tx *sql.Tx, a Approval) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO approvals(id,operation_id,run_id,state,expires_at,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,document=excluded.document`, a.ID, nullableWorkflowString(a.OperationID), a.RunID, a.Status, a.ExpiresAt, string(raw))
	return err
}
func readApprovalTx(ctx context.Context, tx *sql.Tx, runID string) ([]Approval, error) {
	return readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=?", runID)
}
func saveBarrier(ctx context.Context, tx *sql.Tx, b ExecutionBarrier) error {
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO execution_barriers(id,operation_id,run_id,state,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, b.ID, b.OperationID, b.RunID, b.Status, string(raw))
	return err
}
func (m *Manager) Operations(ctx context.Context, id string) ([]Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	o, e := readDocuments[Operation](ctx, m.store.db, "SELECT document FROM operations WHERE run_id=? ORDER BY rowid", id)
	return o, storageFailure(e)
}
func (m *Manager) ContextItems(ctx context.Context, id string) ([]ContextItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	o, e := readDocuments[ContextItem](ctx, m.store.db, "SELECT document FROM context_items WHERE run_id=? ORDER BY rowid", id)
	return o, storageFailure(e)
}
func (m *Manager) Approvals(ctx context.Context) ([]Approval, error) {
	return m.ApprovalsFiltered(ctx, "")
}
func (m *Manager) ApprovalsFiltered(ctx context.Context, workflowID string) ([]Approval, error) {
	return m.ApprovalsByRun(ctx, workflowID, "")
}
func (m *Manager) ApprovalsByRun(ctx context.Context, workflowID, runID string) ([]Approval, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	if err := m.expireApprovals(ctx); err != nil {
		return nil, storageFailure(err)
	}
	o, e := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE (?='' OR run_id IN (SELECT id FROM runs WHERE workflow_id=?)) AND (?='' OR run_id=?) ORDER BY CASE WHEN state IN ('pending','approved') THEN 0 ELSE 1 END, rowid DESC LIMIT 200", workflowID, workflowID, runID, runID)
	return o, storageFailure(e)
}

type ToolCatalogEntry struct {
	tools.PublicSchema
	Source    string      `json:"source"`
	ReadOnly  bool        `json:"readOnly"`
	Selected  bool        `json:"selected"`
	Available bool        `json:"available"`
	Reason    string      `json:"reason,omitempty"`
	Ref       RevisionRef `json:"ref"`
}

func (entry ToolCatalogEntry) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
		Metadata    tools.Metadata `json:"metadata"`
		Source      string         `json:"source"`
		ReadOnly    bool           `json:"readOnly"`
		Selected    bool           `json:"selected"`
		Available   bool           `json:"available"`
		Reason      string         `json:"reason,omitempty"`
		Ref         RevisionRef    `json:"ref"`
	}{entry.Name, entry.Description, entry.Parameters, entry.Metadata, entry.Source, entry.ReadOnly, entry.Selected, entry.Available, entry.Reason, entry.Ref})
}

type ToolCatalog struct {
	Items          []ToolCatalogEntry `json:"items"`
	SnapshotDigest string             `json:"snapshotDigest,omitempty"`
}

func (m *Manager) ToolCatalog(ctx context.Context, sessionID, domain string, available *bool) (ToolCatalog, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := ToolCatalog{Items: []ToolCatalogEntry{}}
	if m.closed {
		return result, closedError()
	}
	selected := map[string]Capability{}
	var currentSnapshot CapabilitySnapshot
	var environment Environment
	if sessionID != "" {
		if _, err := readSession(ctx, m.store.db, sessionID); err != nil {
			return result, storageFailure(err)
		}
		env, err := m.environment(ctx, sessionID)
		if err != nil {
			return result, storageFailure(err)
		}
		snapshot, err := m.snapshot(ctx, env)
		if err != nil {
			var limit *Error
			if !errors.As(err, &limit) || limit.Code != "capability-limit" {
				return result, err
			}
			// Keep oversized existing selections editable without treating this
			// read-only catalog as a valid execution snapshot.
			snapshot.Digest = ""
		}
		result.SnapshotDigest = snapshot.Digest
		currentSnapshot = snapshot
		environment = env
		for _, c := range snapshot.Tools {
			if c.Source == toolDiscoverySource {
				continue
			}
			selected[c.Name] = c
		}
	}
	entries := map[string]ToolCatalogEntry{}
	if m.deps.Tools != nil {
		for _, schema := range m.deps.Tools.Schemas() {
			if schema.Metadata.Exposure != "agent" && !allowed(schema.Name) {
				continue
			}
			_, chosen := selected[schema.Name]
			entry := ToolCatalogEntry{PublicSchema: schema, Source: "builtin", ReadOnly: schema.Metadata.ReadOnly || allowed(schema.Name), Selected: chosen, Available: true, Ref: RevisionRef{ID: "builtin", Revision: 1}}
			entries[schema.Name] = entry
		}
	}
	for name, c := range selected {
		if _, ok := entries[name]; ok {
			continue
		}
		var params map[string]any
		_ = json.Unmarshal(c.Parameters, &params)
		entries[name] = ToolCatalogEntry{PublicSchema: tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: params, Metadata: capabilityMetadata(c)}, Source: c.Source, ReadOnly: c.ReadOnly, Selected: true, Available: true, Ref: c.Ref}
	}
	if extensions, ok := m.deps.Catalog.(*Extensions); ok {
		broader := environment
		broader.Tools = append([]string(nil), environment.Tools...)
		if extensions.Servers != nil {
			for _, server := range environment.Servers {
				catalog, err := extensions.Servers.Catalog(server.ID, server.Revision, server.Digest)
				if err != nil {
					continue
				}
				for _, tool := range catalog.Tools {
					name := capabilityAlias("mcp", server.ID, tool.Name)
					if !contains(broader.Tools, name) {
						broader.Tools = append(broader.Tools, name)
					}
				}
			}
		}
		if broaderSnapshot, err := extensions.Snapshot(ctx, broader); err == nil {
			for _, c := range broaderSnapshot.Tools {
				if _, found := entries[c.Name]; found {
					continue
				}
				var params map[string]any
				_ = json.Unmarshal(c.Parameters, &params)
				_, chosen := selected[c.Name]
				entries[c.Name] = ToolCatalogEntry{PublicSchema: tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: params, Metadata: capabilityMetadata(c)}, Source: c.Source, ReadOnly: c.ReadOnly, Selected: chosen, Available: true, Ref: c.Ref}
			}
		}
		for _, name := range []string{BashExec, BashScript} {
			if _, found := entries[name]; found {
				continue
			}
			c, ready := bashCapability(name, currentSnapshot.Profiles, currentSnapshot.Grants, extensions.Executor != nil && extensions.Workspaces != nil)
			if !ready {
				c, _ = bashCapability(name, []execconfig.Profile{{ID: "profile-required", Runtime: "bash", Enabled: true}}, nil, true)
			}
			var params map[string]any
			_ = json.Unmarshal(c.Parameters, &params)
			if !ready {
				if props, ok := params["properties"].(map[string]any); ok {
					if profile, ok := props["profileId"].(map[string]any); ok {
						delete(profile, "enum")
					}
				}
			}
			entry := ToolCatalogEntry{PublicSchema: tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: params, Metadata: capabilityMetadata(c)}, Source: c.Source, Available: ready, Ref: RevisionRef{ID: "execution", Revision: 1}}
			if !ready {
				entry.Reason = "先在会话环境中固定已启用的 Bash 执行配置，并准备受控执行器"
			}
			entries[name] = entry
		}
	}
	if m.deps.Workspaces != nil {
		for _, name := range []string{TaskWorkspaceList, TaskWorkspaceRead, TaskWorkspaceWrite, TaskWorkspaceCopy, TaskWorkspaceMove, TaskWorkspaceDelete} {
			if _, found := entries[name]; found {
				continue
			}
			c, ok := taskWorkspaceCapability(name)
			if !ok {
				continue
			}
			var params map[string]any
			_ = json.Unmarshal(c.Parameters, &params)
			entries[name] = ToolCatalogEntry{PublicSchema: tools.PublicSchema{Name: c.Name, Description: c.Description, Parameters: params, Metadata: capabilityMetadata(c)}, Source: c.Source, ReadOnly: c.ReadOnly, Available: true, Ref: RevisionRef{ID: "workspace", Revision: 1}}
		}
	}
	for _, entry := range entries {
		if domain != "" && entry.Metadata.Domain != domain {
			continue
		}
		if available != nil && entry.Available != *available {
			continue
		}
		result.Items = append(result.Items, entry)
	}
	sort.Slice(result.Items, func(i, j int) bool { return result.Items[i].Name < result.Items[j].Name })
	return result, nil
}
func (m *Manager) Barriers(ctx context.Context) ([]ExecutionBarrier, error) {
	return m.BarriersFiltered(ctx, "")
}
func (m *Manager) BarriersFiltered(ctx context.Context, workflowID string) ([]ExecutionBarrier, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	o, e := readDocuments[ExecutionBarrier](ctx, m.store.db, "SELECT document FROM execution_barriers WHERE (?='' OR run_id IN (SELECT id FROM runs WHERE workflow_id=?)) ORDER BY rowid DESC LIMIT 200", workflowID, workflowID)
	return o, storageFailure(e)
}
func (m *Manager) Reconcile(ctx context.Context, id, evidence, decision string) (ExecutionBarrier, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b ExecutionBarrier
	if m.closed {
		return b, closedError()
	}
	if len(evidence) < 1 || len(evidence) > 8192 || (decision != "confirmed-completed" && decision != "confirmed-stopped") {
		return b, bad("invalid-reconciliation", "必须提供外部核实证据及 confirmed-completed 或 confirmed-stopped 决定")
	}
	err := m.store.write(ctx, "reconcile", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM execution_barriers WHERE id=?", id).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &b); err != nil {
			return err
		}
		if b.Status == "reconciled" {
			if b.Decision == decision && b.Evidence == evidence {
				return nil
			}
			return &Error{409, "decision-conflict", "该屏障已有不同核实决定"}
		}
		if b.Status != "unknown" {
			return &Error{409, "barrier-state-conflict", "只能核实已标记结果未知的操作；在途操作必须先结束确认流程"}
		}
		b.Status = "reconciled"
		b.Decision = decision
		b.Evidence = evidence
		b.ReconciledAt = stamp(m.deps.Now())
		if err := saveBarrier(ctx, tx, b); err != nil {
			return err
		}
		// A reconciled unknown operation is the only authority allowed to
		// release its resource claims. The evidence and decision are kept on
		// the lease as well as on the execution barrier for audit correlation.
		return settleResourceLease(ctx, tx, b.OperationID, b.ReconciledAt, false, evidence, decision)
	})
	if err == nil {
		m.signal()
	}
	return b, storageFailure(err)
}
func (m *Manager) Decide(ctx context.Context, id, decision string) (Approval, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var a Approval
	if m.closed {
		return a, closedError()
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return a, err
		}
	}
	if decision != "approved" && decision != "denied" {
		return a, bad("invalid-decision", "审批决定必须为 approved 或 denied")
	}
	if err := m.expireApprovals(ctx); err != nil {
		return a, storageFailure(err)
	}
	err := m.store.write(ctx, "approval-decision", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM approvals WHERE id=?", id).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &a); err != nil {
			return err
		}
		if a.Decision == decision {
			return nil
		}
		if a.Status != "pending" {
			return &Error{409, "decision-conflict", "审批已处理、过期或撤销"}
		}
		r, err := readRun(ctx, tx, a.RunID)
		if err != nil {
			return err
		}
		if r.Status != StateWaitingApproval || r.CancelRequestedAt != "" {
			return &Error{409, "run-state-conflict", "运行已不在审批等待状态"}
		}
		if decision == "approved" {
			if err = m.validateWikiRun(ctx, tx, r.ID); err != nil {
				return err
			}
			var count int
			if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&count); err != nil {
				return err
			}
			if count >= r.Limits.QueueCapacity {
				return &Error{429, "queue-full", "任务队列已满，审批保持待处理"}
			}
			r.Status = StateQueued
			r.Phase = "queued"
		} else {
			r.Status = StateFailed
			r.MemoryStatus = "stale"
			r.EndReason = "approval-denied"
			r.Error = &Failure{Code: r.EndReason, Message: "操作者拒绝本次操作，运行已结束"}
			r.EndedAt = stamp(m.deps.Now())
		}
		a.Decision = decision
		a.Status = decision
		a.DecidedAt = stamp(m.deps.Now())
		if err = saveApproval(ctx, tx, a); err != nil {
			return err
		}
		if err = m.store.event(ctx, tx, &r, "approval/"+decision, "", nil, map[string]string{"approvalId": id}); err != nil {
			return err
		}
		if terminal(r.Status) {
			return m.store.releaseSession(ctx, tx, &r)
		}
		return nil
	})
	if err == nil {
		m.signal()
	}
	return a, storageFailure(err)
}
func (m *Manager) expireApprovals(ctx context.Context) error {
	list, err := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE state IN ('pending','approved') AND julianday(expires_at)<=julianday(?)", stamp(m.deps.Now()))
	if err != nil {
		return err
	}
	for _, a := range list {
		_, err = m.store.change(ctx, a.RunID, "approval-expired", func(tx *sql.Tx, r *Run) error {
			a.Status = "expired"
			a.DecidedAt = stamp(m.deps.Now())
			if err := saveApproval(ctx, tx, a); err != nil {
				return err
			}
			if terminal(r.Status) {
				return nil
			}
			r.Status = StateFailed
			if r.WorkflowID != "" {
				r.Status = StateRecoveryRequired
			}
			r.MemoryStatus = "stale"
			r.EndReason = "approval-expired"
			r.EndedAt = stamp(m.deps.Now())
			r.Error = &Failure{Code: r.EndReason, Message: "审批已过期，运行已结束"}
			if err := releaseWaitingResourceLeases(ctx, tx, r.ID, r.EndedAt); err != nil {
				return err
			}
			if r.WorkflowID != "" {
				w, e := readWorkflow(ctx, tx, r.WorkflowID)
				if e != nil {
					return e
				}
				w.Error = r.Error
				w.Status = StateRecoveryRequired
				if e = m.store.workflowEvent(ctx, tx, &w, "workflow/recovery-required", r.Error.Message); e != nil {
					return e
				}
			}
			return m.store.event(ctx, tx, r, "approval/expired", "", nil, map[string]string{"approvalId": a.ID})
		})
		if err != nil {
			return err
		}
	}
	return nil
}
func approvalExpired(a Approval, now time.Time) bool {
	t, err := time.Parse(time.RFC3339Nano, a.ExpiresAt)
	return err != nil || !now.Before(t)
}
func recoverOperations(ctx context.Context, tx *sql.Tx, now time.Time) error {
	operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE state='dispatched'")
	if err != nil {
		return err
	}
	for _, o := range operations {
		o.Status = "unknown"
		o.EndedAt = stamp(now)
		o.Error = &Failure{Code: "outcome-unknown", Message: "面板重启时操作已派发，结果未确认"}
		if err = saveOperation(ctx, tx, o); err != nil {
			return err
		}
		// Even a trusted read can lose its stop acknowledgement at restart.
		// Every retained unknown lease needs an explicit reconciliation handle.
		var barriers int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE operation_id=?", o.ID).Scan(&barriers); err != nil {
			return err
		}
		if barriers == 0 {
			b := ExecutionBarrier{ID: o.ID, WorkflowID: o.WorkflowID, RunID: o.RunID, OperationID: o.ID, Status: "unknown", CreatedAt: o.DispatchedAt}
			if err := saveBarrier(ctx, tx, b); err != nil {
				return err
			}
		}
	}
	barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE state='dispatched'")
	if err != nil {
		return err
	}
	for _, b := range barriers {
		var state string
		if err := tx.QueryRowContext(ctx, "SELECT state FROM operations WHERE id=?", b.OperationID).Scan(&state); err != nil {
			return err
		}
		if state == StateWaitingTask {
			continue
		}
		b.Status = "unknown"
		if err = saveBarrier(ctx, tx, b); err != nil {
			return err
		}
	}
	return recoverResourceLeases(ctx, tx)
}
