package harness

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

func (m *Manager) environment(ctx context.Context, id string) (Environment, error) {
	var raw string
	err := readView(ctx, m.store).EnvironmentSnapshot(ctx, id, &raw)
	if errors.Is(err, sessionstore.ErrNotFound) {
		names := []string{}
		if m.deps.Tools != nil {
			for _, schema := range m.deps.Tools.Schemas() {
				if !retiredFromNewChats(schema.Name) && (allowed(schema.Name) || schema.Metadata.Exposure == "agent") {
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
	value, readErr := storeRead(ctx, m.store, "GetEnvironment", func(ctx context.Context) (Environment, error) {
		if _, err := readSession(ctx, m.store, id); err != nil {
			return Environment{}, err
		}
		e, err := m.environment(ctx, id)
		return e, err
	})
	return value, storageFailure(readErr)
}
func (m *Manager) PutEnvironment(ctx context.Context, id string, expected int, e Environment) (Environment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return e, closedError()
	}
	session, err := readSession(ctx, m.store, id)
	if err != nil {
		return e, storageFailure(err)
	}
	if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		return e, &Error{Status: 409, Code: "session-busy", Message: "会话忙碌时不能修改环境"}
	}
	old, err := m.environment(ctx, id)
	if err != nil {
		return e, storageFailure(err)
	}
	if old.Revision != expected {
		return e, &Error{Status: 409, Code: "revision-conflict", Message: "会话环境版本已变化"}
	}
	e.SessionID = id
	e.Revision = expected + 1
	fixed, err := m.snapshot(ctx, e)
	if err != nil {
		return e, err
	}
	e = fixed.Environment
	raw, _ := json.Marshal(e)
	err = writeStore(m.store, ctx, "environment", func(tx sessionstore.Tx) error {
		_, err := tx.InsertEnvironment(ctx, id, e.Revision, string(raw))
		return err
	})
	return e, storageFailure(err)
}
func (m *Manager) snapshot(ctx context.Context, e Environment) (CapabilitySnapshot, error) {
	return m.snapshotWithMode(ctx, e, false)
}

func (m *Manager) snapshotWithMode(ctx context.Context, e Environment, modern bool) (CapabilitySnapshot, error) {
	var s CapabilitySnapshot
	var err error
	if m.deps.Catalog != nil {
		if extensions, ok := m.deps.Catalog.(*Extensions); ok {
			s, err = extensions.snapshot(ctx, e, modern)
		} else {
			s, err = m.deps.Catalog.Snapshot(ctx, e)
		}
		if err != nil {
			return s, err
		}
	} else if len(e.Skills)+len(e.Servers)+len(e.ExecutionProfiles)+len(e.Grants) > 0 {
		return s, bad("capability-unavailable", "扩展能力尚未配置")
	}
	fixedSkills, fixedServers := s.Environment.Skills, s.Environment.Servers
	s.Environment = e
	if fixedSkills != nil {
		s.Environment.Skills = fixedSkills
	}
	if fixedServers != nil {
		s.Environment.Servers = fixedServers
	}
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
		rule, readErr := readResourceRule(ctx, m.store, ref.ID, ref.Revision)
		if readErr != nil {
			return s, storageFailure(readErr)
		}
		latest, readErr := readResourceRule(ctx, m.store, ref.ID, 0)
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
					s.Tools = append(s.Tools, Capability{Name: name, SearchNames: append([]string(nil), t.SearchNames...), Description: t.Description, Parameters: raw, Source: "builtin", ReadOnly: t.Metadata.ReadOnly || allowed(name), Metadata: t.Metadata, CatalogDigest: hstate.DigestJSON(t)})
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

	for _, c := range s.Materials {
		if c.Name == toolSearchName || c.Source == toolDiscoverySource || c.Name == userInputTool || c.Source == userInputSource || c.Name == planTool || c.Source == planSource || c.Source == taskHistorySource {
			return s, bad("reserved-capability", "资料目录使用了内核保留的工具名称或来源")
		}
	}
	for _, c := range s.Tools {
		if c.Name == toolSearchName || c.Source == toolDiscoverySource || c.Name == userInputTool || c.Source == userInputSource || c.Name == planTool || c.Source == planSource || c.Source == taskHistorySource {
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
	s.Digest = hstate.DigestJSON(s)
	return s, nil
}

func (m *Manager) Operations(ctx context.Context, id string) ([]Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	value, readErr := storeRead(ctx, m.store, "Operations", func(ctx context.Context) ([]Operation, error) {
		o, e := readView(ctx, m.store).Operations(ctx, id)
		return o, e
	})
	return value, storageFailure(readErr)
}
func (m *Manager) ContextItems(ctx context.Context, id string) ([]ContextItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	value, readErr := storeRead(ctx, m.store, "ContextItems", func(ctx context.Context) ([]ContextItem, error) {
		o, e := readView(ctx, m.store).ContextItems(ctx, id)
		return o, e
	})
	return value, storageFailure(readErr)
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
	o, e := readView(ctx, m.store).Approvals(ctx, workflowID, workflowID, runID, runID)

	if e == nil {
		for i := range o {
			if o[i].Access != nil {
				current, err := readOperation(ctx, m.store, o[i].OperationID)
				if err != nil {
					return nil, storageFailure(err)
				}
				o[i].Operation.Preparation = current.Preparation
			}
		}
	}
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
		if _, err := readSession(ctx, m.store, sessionID); err != nil {
			return result, storageFailure(err)
		}
		env, err := m.environment(ctx, sessionID)
		if err != nil {
			return result, storageFailure(err)
		}
		env = m.withCurrentAgentTools(env)
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
			if retiredFromNewChats(schema.Name) || (schema.Metadata.Exposure != "agent" && !allowed(schema.Name)) {
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
	value, readErr := storeRead(ctx, m.store, "BarriersFiltered", func(ctx context.Context) ([]ExecutionBarrier, error) {
		o, e := readView(ctx, m.store).Barriers(ctx, workflowID, workflowID)
		return o, e
	})
	return value, storageFailure(readErr)
}
func (m *Manager) Decide(ctx context.Context, id, decision string) (Approval, error) {
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	defer m.mu.Unlock()
	var a Approval
	if m.closed {
		return a, closedError()
	}
	if guardErr != nil {
		return a, guardErr
	}
	if decision != "approved" && decision != "denied" {
		return a, bad("invalid-decision", "审批决定必须为 approved 或 denied")
	}
	if err := m.expireApprovals(ctx); err != nil {
		return a, storageFailure(err)
	}
	err := writeStore(m.store, ctx, "approval-decision", func(tx sessionstore.Tx) error {
		var raw string
		if err := tx.ApprovalRecord(ctx, id, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &a); err != nil {
			return err
		}
		if a.Access != nil {
			return bad("access-decision-required", "请通过运行时授权接口提交决定")
		}
		if a.Decision == decision {
			return nil
		}
		if a.Status != "pending" {
			return &Error{Status: 409, Code: "decision-conflict", Message: "审批已处理、过期或撤销"}
		}
		r, err := readRun(ctx, tx, a.RunID)
		if err != nil {
			return err
		}
		if r.Status != StateWaitingApproval || r.CancelRequestedAt != "" {
			return &Error{Status: 409, Code: "run-state-conflict", Message: "运行已不在审批等待状态"}
		}
		if decision == "approved" {
			var count int
			if err = tx.QueuedRunCount(ctx, &count); err != nil {
				return err
			}
			if count >= r.Limits.QueueCapacity {
				return &Error{Status: 429, Code: "queue-full", Message: "任务队列已满，审批保持待处理"}
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
		if err = tx.Event(ctx, &r, "approval/"+decision, "", nil, map[string]string{"approvalId": id}); err != nil {
			return err
		}
		if hstate.Terminal(r.Status) {
			return tx.ReleaseSession(ctx, &r)
		}
		return nil
	})
	if err == nil {
		m.signal()
	}
	return a, storageFailure(err)
}
func (m *Manager) expireApprovals(ctx context.Context) error {
	list, err := readView(ctx, m.store).ExpiredApprovals(ctx, stamp(m.deps.Now()))
	if err != nil {
		return err
	}
	for _, a := range list {
		_, err = m.store.ChangeRun(ctx, a.RunID, "approval-expired", func(tx sessionstore.Tx, r *Run) error {
			a.Status = "expired"
			a.DecidedAt = stamp(m.deps.Now())
			if err := saveApproval(ctx, tx, a); err != nil {
				return err
			}
			if hstate.Terminal(r.Status) {
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
				if e = tx.WorkflowEvent(ctx, &w, "workflow/recovery-required", r.Error.Message); e != nil {
					return e
				}
			}
			return tx.Event(ctx, r, "approval/expired", "", nil, map[string]string{"approvalId": a.ID})
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
