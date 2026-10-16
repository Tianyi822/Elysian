package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/mcp"
)

type CapabilityRevocation struct {
	Cursor    string `json:"cursor"`
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"createdAt"`
}

type CapabilityRevocationQuery struct {
	Kind   string
	ID     string
	Cursor string
	Limit  int
}

func (m *Manager) CapabilityRevocations(ctx context.Context, query CapabilityRevocationQuery) (Page[CapabilityRevocation], error) {
	page := Page[CapabilityRevocation]{Items: []CapabilityRevocation{}, NextCursor: query.Cursor}
	if query.Limit < 1 || query.Limit > 200 {
		return page, bad("invalid-limit", "每页条数必须为 1 到 200 的整数")
	}
	cursor := int64(0)
	if query.Cursor != "" {
		parsed, err := strconv.ParseInt(query.Cursor, 10, 64)
		if err != nil || parsed < 0 || strconv.FormatInt(parsed, 10) != query.Cursor {
			return page, bad("invalid-cursor", "撤销记录游标必须为规范非负十进制字符串")
		}
		cursor = parsed
	}
	if query.Kind != "" && query.Kind != "skill" && query.Kind != "mcp" && query.Kind != "execution-profile" && query.Kind != "grant" {
		return page, bad("invalid-revocation", "撤销能力类型无效")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.store == nil || m.store.db == nil {
		return page, closedError()
	}
	rows, err := m.store.db.QueryContext(ctx, `SELECT rowid,kind,id,revision,reason,created_at
		FROM capability_revocations WHERE rowid>? AND (?='' OR kind=?) AND (?='' OR id=?)
		ORDER BY rowid LIMIT ?`, cursor, query.Kind, query.Kind, query.ID, query.ID, query.Limit+1)
	if err != nil {
		return page, storageFailure(err)
	}
	defer rows.Close()
	for rows.Next() {
		var rowID int64
		var item CapabilityRevocation
		if err := rows.Scan(&rowID, &item.Kind, &item.ID, &item.Revision, &item.Reason, &item.CreatedAt); err != nil {
			return page, storageFailure(err)
		}
		item.Cursor = strconv.FormatInt(rowID, 10)
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return Page[CapabilityRevocation]{}, storageFailure(err)
	}
	if len(page.Items) > query.Limit {
		page.HasMore = true
		page.Items = page.Items[:query.Limit]
	}
	if len(page.Items) > 0 {
		page.NextCursor = page.Items[len(page.Items)-1].Cursor
	}
	return page, nil
}

// 显式引用成为父端生成的持久资料加载组；挂起恢复同模型提议使用同一游标。
func (a *agentExecution) selectedMaterials(ctx context.Context) (*worker.ModelResponse, error) {
	if a.run.DriverVersion != "v2" || a.run.Selection == nil || a.run.Snapshot == nil {
		return nil, nil
	}
	input := a.run.Selection
	if len(input.Skills)+len(input.Resources)+len(input.Prompts) == 0 {
		return nil, nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	var count int
	if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM model_requests WHERE run_id=? AND request_index=-1", a.run.ID).Scan(&count); err != nil {
		return nil, storageFailure(err)
	}
	if count > 0 {
		return nil, nil
	}
	record := ModelRequestRecord{ID: m.deps.NewID(), RunID: a.run.ID, Index: -1, Purpose: "input-material", Status: StateSucceeded, StartedAt: stamp(m.deps.Now()), EndedAt: stamp(m.deps.Now()), ContextRefs: []EvidenceRef{}, HistorySeq: a.run.HistorySeq, Response: &model.Response{FinishReason: "tool_calls"}}
	add := func(c Capability, args json.RawMessage) {
		record.Response.ToolCalls = append(record.Response.ToolCalls, model.ToolCall{ID: record.ID + "_" + strconv.Itoa(len(record.Response.ToolCalls)), Name: c.Name, Arguments: args})
	}
	for _, ref := range input.Skills {
		for _, c := range a.run.Snapshot.Tools {
			if c.Source == "skill-load" && c.Ref.ID == ref.ID && c.Ref.Revision == ref.Revision {
				add(c, json.RawMessage(`{"path":"SKILL.md"}`))
			}
		}
	}
	for _, ref := range input.Resources {
		for _, c := range a.run.Snapshot.Tools {
			if c.Source == "mcp-resource" && c.Ref.ID == ref.ServerID && c.OriginalName == ref.URI {
				add(c, json.RawMessage(`{}`))
			}
		}
	}
	for _, ref := range input.Prompts {
		found := false
		for _, c := range a.run.Snapshot.Materials {
			if c.Source == "mcp-prompt" && c.Ref.ID == ref.ServerID && c.OriginalName == ref.Name {
				if err := a.validateProposal(c.Name, ref.Arguments); err != nil {
					return nil, err
				}
				add(c, ref.Arguments)
				found = true
			}
		}
		if !found {
			return nil, bad("prompt-not-found", "提示模板不在固定发现目录中")
		}
	}
	if len(record.Response.ToolCalls) > a.run.Limits.MaxSteps {
		return nil, bad("call-budget", "显式资料加载数量超过调用预算")
	}
	_, err := m.store.change(ctx, a.run.ID, "materials-intent", func(tx *sql.Tx, r *Run) error {
		record.EventSeq = nextSeq(r.LastSeq)
		if err := saveModelRequest(ctx, tx, record); err != nil {
			return err
		}
		return m.store.event(ctx, tx, r, "materials/selected", "", nil, map[string]string{"modelRequestId": record.ID})
	})
	if err != nil {
		return nil, storageFailure(err)
	}
	a.pending = &record
	a.pendingIndex = 0
	projection, err := a.projection(record, 0)
	return &projection, err
}

func (m *Manager) checkRevocations(ctx context.Context, s CapabilitySnapshot, o Operation) error {
	refs := []struct {
		kind string
		ref  RevisionRef
	}{{"skill", o.Capability.Ref}}
	if o.Capability.Source == "mcp-tool" || o.Capability.Source == "mcp-resource" || o.Capability.Source == "mcp-prompt" {
		refs[0].kind = "mcp"
	}
	if o.Execution != nil {
		refs = append(refs, struct {
			kind string
			ref  RevisionRef
		}{"execution-profile", RevisionRef{ID: o.Execution.Profile.ID, Revision: o.Execution.Profile.Revision}})
		if o.Execution.Grant != nil {
			refs = append(refs, struct {
				kind string
				ref  RevisionRef
			}{"grant", RevisionRef{ID: o.Execution.Grant.ID, Revision: o.Execution.Grant.Revision}})
		}
	}
	for _, grant := range s.Environment.Grants {
		refs = append(refs, struct {
			kind string
			ref  RevisionRef
		}{"grant", grant})
	}
	for _, entry := range refs {
		if entry.ref.ID == "" {
			continue
		}
		var n int
		if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", entry.kind, entry.ref.ID, entry.ref.Revision).Scan(&n); err != nil {
			return storageFailure(err)
		}
		if n > 0 {
			return bad("capability-revoked", "该能力已显式撤销，旧快照和审批不能继续执行")
		}
	}
	return nil
}
func (m *Manager) Revoke(ctx context.Context, kind, id string, revision int, reason string) error {
	if kind != "skill" && kind != "mcp" && kind != "execution-profile" && kind != "grant" {
		return bad("invalid-revocation", "撤销能力类型无效")
	}
	if id == "" || revision < 0 || len(reason) == 0 || len(reason) > 2048 {
		return bad("invalid-revocation", "必须提供能力编号、修订和中文撤销原因")
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return closedError()
	}
	err := storageFailure(m.store.write(ctx, "capability-revoke", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO capability_revocations(kind,id,revision,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", kind, id, revision, reason, stamp(m.deps.Now()))
		return err
	}))
	if err == nil && kind == "grant" {
		for _, active := range m.executions {
			run, readErr := m.store.get(ctx, active.runID)
			if readErr != nil {
				err = storageFailure(readErr)
				break
			}
			if run.Snapshot == nil {
				continue
			}
			for _, grant := range run.Snapshot.Environment.Grants {
				if grant.ID == id && (revision == 0 || grant.Revision == revision) {
					active.cancel()
					break
				}
			}
		}
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	// 撤销已持久化后，回收仍持有授权的容器和隧道；不持有 Manager 锁等待进程。
	if e, ok := m.deps.Catalog.(*Extensions); ok && e.Executor != nil {
		switch kind {
		case "grant":
			err = e.Executor.RevokeGrant(ctx, id, revision)
		case "mcp":
			err = e.Executor.RevokeServer(ctx, id, revision)
		}
		if err != nil {
			m.mu.Lock()
			m.blocked = "撤销已保存，但受管容器停止未确认，任务派发已暂停"
			m.mu.Unlock()
			return capabilityError(err)
		}
	}
	return nil
}

// 探测可能启动 stdio 代码，因此同样服从持久撤销和维护派发守卫。
func (m *Manager) checkProbe(ctx context.Context, server mcp.Server) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.checkProbeLocked(ctx, server)
}

func (m *Manager) checkProbeLocked(ctx context.Context, server mcp.Server) error {
	if m.closed || m.store == nil {
		return closedError()
	}
	if err := m.store.recordsFault(); err != nil {
		return &Error{503, "record-storage-unavailable", err.Error()}
	}
	if m.blocked != "" {
		return &Error{503, "runtime-unavailable", m.blocked}
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return err
		}
	}
	o := Operation{Capability: Capability{Source: "mcp-tool", Ref: RevisionRef{ID: server.ID, Revision: server.Revision}}}
	if server.Stdio != nil && server.Stdio.GrantID != "" {
		o.Execution = &ExecutionPlan{Grant: &execconfig.Grant{ID: server.Stdio.GrantID, Revision: server.Stdio.GrantRevision}}
	}
	return m.checkRevocations(ctx, CapabilitySnapshot{}, o)
}

// 在 Worker 和 HTTP 入口开放前恢复执行器拒绝表，避免重启复活已撤销的容器授权。
func (m *Manager) restoreExecutionRevocations(ctx context.Context) error {
	e, ok := m.deps.Catalog.(*Extensions)
	if !ok || e.Executor == nil {
		return nil
	}
	rows, err := m.store.db.QueryContext(ctx, "SELECT kind,id,revision FROM capability_revocations WHERE kind IN ('grant','mcp')")
	if err != nil {
		return err
	}
	type revocation struct {
		kind, id string
		revision int
	}
	var entries []revocation
	for rows.Next() {
		var r revocation
		if err = rows.Scan(&r.kind, &r.id, &r.revision); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range entries {
		if r.kind == "grant" {
			err = e.Executor.RevokeGrant(ctx, r.id, r.revision)
		} else {
			err = e.Executor.RevokeServer(ctx, r.id, r.revision)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
