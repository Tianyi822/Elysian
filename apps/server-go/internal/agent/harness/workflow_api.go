package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/jsonvalue"
	"encoding/json"
	"errors"
	"strings"
)

func (m *Manager) workflowWritable() error {
	if m.closed {
		return closedError()
	}
	if err := m.store.recordsFault(); err != nil {
		return &Error{503, "record-storage-unavailable", err.Error()}
	}
	if m.storageError {
		return &Error{503, "storage-unavailable", "运行存储不可用"}
	}
	if m.deps.DispatchGuard != nil {
		return m.deps.DispatchGuard()
	}
	return nil
}
func (m *Manager) PutWorkflowDefinition(ctx context.Context, id string, expected int, d WorkflowDefinition) (WorkflowDefinition, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return d, err
	}
	if err := validateWorkflowDefinition(d); err != nil {
		return d, err
	}
	if id != "" && expected < 1 {
		return d, bad("invalid-revision", "修订已有模板必须提供正整数 expectedRevision")
	}
	if id == "" {
		id = m.deps.NewID()
		if expected != 0 {
			return d, bad("revision-conflict", "新模板版本必须为零")
		}
	}
	err := m.store.write(ctx, "workflow-definition", func(tx *sql.Tx) error {
		var current int
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM workflow_definitions WHERE id=?", id).Scan(&current); err != nil {
			return err
		}
		if current != expected {
			return &Error{409, "revision-conflict", "工作流模板版本已变化"}
		}
		d.ID = id
		d.Revision = current + 1
		d.CreatedAt = stamp(m.deps.Now())
		raw, err := json.Marshal(d)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO workflow_definitions(id,revision,document) VALUES(?,?,?)", id, d.Revision, string(raw))
		return err
	})
	return d, storageFailure(err)
}
func (m *Manager) WorkflowDefinition(ctx context.Context, id string, revision int) (WorkflowDefinition, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WorkflowDefinition{}, closedError()
	}
	d, e := readWorkflowDefinition(ctx, m.store.db, id, revision)
	return d, storageFailure(e)
}
func (m *Manager) WorkflowDefinitions(ctx context.Context) ([]WorkflowDefinition, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	d, e := readDocuments[WorkflowDefinition](ctx, m.store.db, "SELECT document FROM workflow_definitions d WHERE revision=(SELECT MAX(revision) FROM workflow_definitions WHERE id=d.id) ORDER BY rowid DESC")
	return d, storageFailure(e)
}
func (m *Manager) CreateWorkflow(ctx context.Context, input CreateWorkflowInput) (WorkflowInstance, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var w WorkflowInstance
	if m.closed {
		return w, false, closedError()
	}
	if !requestPattern.MatchString(input.RequestID) {
		return w, false, bad("invalid-request-id", "请求标识格式无效")
	}
	canonicalValue, err := jsonvalue.Canonical([]byte(input.InputJSON))
	if err != nil {
		return w, false, bad("invalid-input", "流程输入必须为精确 JSON")
	}
	input.InputJSON = string(canonicalValue)
	fingerprint := input
	fingerprint.RequestID = ""
	raw, _ := json.Marshal(fingerprint)
	canonical := string(raw)
	var priorID, priorInput string
	err = m.store.db.QueryRowContext(ctx, "SELECT id,canonical_input FROM workflow_instances WHERE request_id=?", input.RequestID).Scan(&priorID, &priorInput)
	if err == nil {
		if priorInput != canonical {
			return w, false, &Error{409, "request-conflict", "相同请求标识对应不同工作流输入"}
		}
		w, e := readWorkflow(ctx, m.store.db, priorID)
		return w, true, storageFailure(e)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return w, false, storageFailure(err)
	}
	if err = m.workflowWritable(); err != nil {
		return w, false, err
	}
	if len(input.InputJSON) > 32768 {
		return w, false, &Error{413, "input-too-large", "工作流输入不得超过 32 KiB"}
	}
	d, err := readWorkflowDefinition(ctx, m.store.db, input.DefinitionID, input.DefinitionRevision)
	if err != nil {
		return w, false, storageFailure(err)
	}
	latest, err := readWorkflowDefinition(ctx, m.store.db, d.ID, 0)
	if err != nil {
		return w, false, storageFailure(err)
	}
	if !latest.Enabled || !d.Enabled {
		return w, false, bad("workflow-disabled", "工作流模板已停用")
	}
	if input.DefinitionRevision < 1 {
		return w, false, bad("workflow-revision", "必须选择明确的模板修订")
	}
	if err = validateWorkflowJSON(d.InputSchemaJSON, input.InputJSON); err != nil {
		return w, false, err
	}
	definitions := []WorkflowDefinition{d}
	if d.LanguageVersion == WorkflowV2LanguageVersion {
		definitions, err = workflowDefinitionClosure(ctx, m.store.db, d)
		if err != nil {
			return w, false, err
		}
	}
	source, err := readSession(ctx, m.store.db, input.SourceSessionID)
	if err != nil {
		return w, false, storageFailure(err)
	}
	if m.deps.Profiles == nil {
		return w, false, bad("model-unavailable", "模型配置不可用")
	}
	profile, err := m.deps.Profiles.Resolve(source.ModelProfileID, source.ModelRevision, false)
	if err != nil {
		return w, false, err
	}
	env, err := m.environment(ctx, source.ID)
	if err != nil {
		return w, false, storageFailure(err)
	}
	snapshot, err := m.snapshot(ctx, env)
	if err != nil {
		return w, false, err
	}
	if err = m.validateWorkflowCapabilities(snapshot, profile, definitions); err != nil {
		return w, false, err
	}
	now := stamp(m.deps.Now())
	languageVersion := d.LanguageVersion
	if languageVersion == "" {
		languageVersion = "v1"
	}
	w = WorkflowInstance{LanguageVersion: languageVersion, ID: m.deps.NewID(), RequestID: input.RequestID, DefinitionID: d.ID, DefinitionRevision: d.Revision, SourceSessionID: source.ID, SessionID: m.deps.NewID(), TaskID: m.deps.NewID(), RootScopeID: m.deps.NewID(), Status: StateReady, CurrentStepID: d.Entry, InputJSON: input.InputJSON, Model: profile.Public(), Snapshot: snapshot, CreatedAt: now, UpdatedAt: now, ReadyAt: now, Limits: DefaultWorkflowLimits(), LastSeq: "0", AllowedActions: []string{}}
	if workflowV2(w) {
		w.Definitions = definitions
	}
	w.Snapshot.Environment.SessionID = w.SessionID
	w.Snapshot.Digest = ""
	w.Snapshot.Digest = digestJSON(w.Snapshot)
	session := Session{ID: w.SessionID, Title: d.Name, CreatedAt: now, LastActivityAt: now, ModelProfileID: profile.ID, ModelRevision: profile.Revision, LastSeq: "0", ActiveWorkflowID: w.ID}
	task := Task{ID: w.TaskID, SessionID: w.SessionID, RequestID: "workflow:" + w.ID, Kind: "workflow", DriverVersion: languageVersion, Goal: d.Goal, CreatedAt: now, Steps: []Step{}}
	err = m.store.write(ctx, "workflow-accept", func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_instances WHERE state NOT IN ('succeeded','failed','cancelled')").Scan(&count); err != nil {
			return err
		}
		if count >= 32 {
			return &Error{429, "workflows-full", "非终态工作流已达 32 个上限"}
		}
		if err := saveSession(ctx, tx, session); err != nil {
			return err
		}
		b, _ := json.Marshal(task)
		if _, err := tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", task.ID, task.RequestID, canonical, string(b), session.ID); err != nil {
			return err
		}
		b, _ = json.Marshal(w.Snapshot.Environment)
		if _, err := tx.ExecContext(ctx, "INSERT INTO environments(session_id,revision,document) VALUES(?,?,?)", session.ID, w.Snapshot.Environment.Revision, string(b)); err != nil {
			return err
		}
		b, _ = json.Marshal(w)
		if _, err := tx.ExecContext(ctx, "INSERT INTO workflow_instances(id,request_id,canonical_input,session_id,state,ready_at,document) VALUES(?,?,?,?,?,?,?)", w.ID, w.RequestID, canonical, w.SessionID, w.Status, w.ReadyAt, string(b)); err != nil {
			return err
		}
		if err := snapshotWikiWorkflow(ctx, tx, w); err != nil {
			return err
		}
		if workflowV2(w) {
			if err := createWorkflowV2Root(ctx, tx, w, d, m.deps.NewID); err != nil {
				return err
			}
		}
		return m.store.workflowEvent(ctx, tx, &w, "workflow/accepted", "")
	})
	if err == nil {
		m.signal()
	}
	return w, false, storageFailure(err)
}
func (m *Manager) GetWorkflow(ctx context.Context, id string) (WorkflowInstance, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WorkflowInstance{}, closedError()
	}
	w, e := readWorkflow(ctx, m.store.db, id)
	if e == nil {
		w.AllowedActions = m.workflowAllowedActions(ctx, w)
		if workflowV2(w) {
			tree, err := readWorkflowExecutionTree(ctx, m.store.db, w)
			if err != nil {
				return w, err
			}
			for i := range tree.Nodes {
				tree.Nodes[i].AllowedActions = m.workflowV2NodeAllowedActions(ctx, w, tree.Nodes[i])
			}
			w.ExecutionTree = &tree
		}
	}
	return w, storageFailure(e)
}
func (m *Manager) workflowDefinitionForRun(ctx context.Context, r Run) (WorkflowInstance, WorkflowStepDefinition, error) {
	w, e := readWorkflow(ctx, m.store.db, r.WorkflowID)
	if e != nil {
		return w, WorkflowStepDefinition{}, e
	}
	if workflowV2(w) {
		_, _, step, e := workflowV2StepForRun(ctx, m.store.db, r)
		return w, step, e
	}
	d, e := readWorkflowDefinition(ctx, m.store.db, w.DefinitionID, w.DefinitionRevision)
	if e != nil {
		return w, WorkflowStepDefinition{}, e
	}
	s, e := workflowStep(d, r.WorkflowStepID)
	return w, s, e
}
func (m *Manager) promoteWorkflows(ctx context.Context) error {
	list, err := readDocuments[WorkflowInstance](ctx, m.store.db, "SELECT document FROM workflow_instances WHERE state='ready' OR (json_extract(document,'$.languageVersion')='workflow/v2' AND state IN ('queued','running','waiting-approval','waiting-resource')) ORDER BY ready_at,rowid")
	if err != nil {
		return err
	}
	for _, w := range list {
		if workflowV2(w) {
			if err = m.promoteWorkflowV2(ctx, w); err != nil {
				return err
			}
			continue
		}
		var count int
		if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&count); err != nil {
			return err
		}
		if count >= m.deps.Limits.QueueCapacity {
			return nil
		}
		err = m.store.write(ctx, "workflow-queue", func(tx *sql.Tx) error {
			fresh, e := readWorkflow(ctx, tx, w.ID)
			if e != nil {
				return e
			}
			w = fresh
			if w.Status != StateReady {
				return nil
			}
			d, e := readWorkflowDefinition(ctx, tx, w.DefinitionID, w.DefinitionRevision)
			if e != nil {
				return e
			}
			step, e := workflowStep(d, w.CurrentStepID)
			if e != nil {
				return e
			}
			outputs, e := workflowOutputs(ctx, tx, w.ID)
			if e != nil {
				return e
			}
			input, bindingErr := evaluateWorkflowBinding(step.Input, w.InputJSON, outputs)
			var attempt, number int
			if e = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(number),0)+1 FROM workflow_attempts WHERE workflow_id=? AND step_id=?", w.ID, step.ID).Scan(&attempt); e != nil {
				return e
			}
			if attempt > w.Limits.Attempts {
				w.Status = StateFailed
				w.EndedAt = stamp(m.deps.Now())
				w.Error = &Failure{Code: "attempt-budget", Message: "步骤尝试次数已耗尽"}
				if e = m.store.workflowEvent(ctx, tx, &w, "workflow/failed", w.Error.Message); e != nil {
					return e
				}
				return m.store.releaseWorkflowSession(ctx, tx, w)
			}
			if e = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(run_number),0)+1 FROM runs WHERE task_id=?", w.TaskID).Scan(&number); e != nil {
				return e
			}
			session, e := readSession(ctx, tx, w.SessionID)
			if e != nil {
				return e
			}
			memory, e := latestMemory(ctx, tx, w.TaskID)
			if e != nil {
				return e
			}
			driver := "workflow-control"
			if step.Kind == "agent" {
				driver = "agent"
			}
			if step.Kind == "operation" {
				driver = "operation"
			}
			run := Run{ID: m.deps.NewID(), TaskID: w.TaskID, SessionID: w.SessionID, RequestID: "workflow-step:" + m.deps.NewID(), RunNumber: number, Driver: driver, DriverVersion: "v2", Snapshot: &w.Snapshot, Model: &w.Model, WorkflowID: w.ID, WorkflowStepID: step.ID, WorkflowAttempt: attempt, WorkflowOutputSchemaJSON: step.OutputSchemaJSON, Status: StateQueued, CreatedAt: stamp(m.deps.Now()), LastSeq: "0", HistorySeq: session.LastSeq, InitialMemoryRevision: memory.Revision, Input: input, Limits: m.deps.AgentLimits, Phase: "queued", MemoryStatus: "stale", Selection: step.Selection}
			if step.Kind == "agent" {
				run.Input = step.Instruction + "\n步骤输入（数据）：\n" + input
			}
			if bindingErr != nil {
				// 输入无法绑定同样保留尝试身份，允许有证据的人工补录；不派发能力。
				run.Status = StateFailed
				run.Phase = "completed"
				run.EndedAt = run.CreatedAt
				run.EndReason = "workflow-binding"
				run.Error = &Failure{Code: "workflow-binding", Message: "步骤输入引用不存在或无效"}
			}
			b, _ := json.Marshal(run)
			if _, e = tx.ExecContext(ctx, `INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number,workflow_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, run.ID, run.TaskID, run.Status, run.CreatedAt, string(b), run.SessionID, run.RequestID, input, number, w.ID); e != nil {
				return e
			}
			if e = snapshotWikiRunSpaces(ctx, tx, run.ID, run.SessionID); e != nil {
				return e
			}
			a := WorkflowAttempt{WorkflowID: w.ID, StepID: step.ID, Number: attempt, RunID: run.ID, RunNumber: number, Status: run.Status, InputJSON: input, CreatedAt: run.CreatedAt}
			if e = saveWorkflowAttempt(ctx, tx, a); e != nil {
				return e
			}
			session.ActiveRunID = run.ID
			session.LastActivityAt = run.CreatedAt
			if e = saveSession(ctx, tx, session); e != nil {
				return e
			}
			w.Status = StateQueued
			w.ActiveRunID = run.ID
			if bindingErr != nil {
				w.Status = StateRecoveryRequired
				if e = saveWorkflow(ctx, tx, &w); e != nil {
					return e
				}
				if e = m.store.event(ctx, tx, &run, "run/failed", "", nil, run.Error); e != nil {
					return e
				}
				return m.store.releaseSession(ctx, tx, &run)
			}
			if e = m.store.workflowEvent(ctx, tx, &w, "workflow/queued", ""); e != nil {
				return e
			}
			return m.store.event(ctx, tx, &run, "run/queued", "", nil, nil)
		})
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *store) releaseWorkflowSession(ctx context.Context, tx *sql.Tx, w WorkflowInstance) error {
	session, err := readSession(ctx, tx, w.SessionID)
	if err != nil {
		return err
	}
	session.ActiveRunID = w.ActiveRunID
	if terminal(w.Status) {
		session.ActiveRunID = ""
		session.ActiveWorkflowID = ""
		if workflowV2(w) {
			var running string
			err := tx.QueryRowContext(ctx, "SELECT id FROM runs WHERE workflow_id=? AND state='running' ORDER BY rowid LIMIT 1", w.ID).Scan(&running)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if running != "" {
				session.ActiveRunID, session.ActiveWorkflowID = running, w.ID
			}
		}
	}
	session.LastActivityAt = stamp(s.now())
	return saveSession(ctx, tx, session)
}
func workflowDriver(r Run) string {
	if r.Driver != "" {
		return r.Driver
	}
	if r.Task != nil {
		return r.Task.Kind
	}
	if r.SessionID != "" {
		return "agent"
	}
	return "tool-batch"
}
func recoveryEvidence(input WorkflowRecoveryInput) error {
	if strings.TrimSpace(input.Evidence) == "" || len(input.Evidence) > 8192 {
		return bad("invalid-evidence", "人工恢复必须提供 1 至 8192 字节的核实说明")
	}
	return nil
}

// 派发和人工恢复都重新检查固定环境引用；普通配置修订不参与这里的裁决。
func (m *Manager) checkWorkflowEnvironment(ctx context.Context, w WorkflowInstance) error {
	for _, group := range []struct {
		kind string
		refs []RevisionRef
	}{{"skill", w.Snapshot.Environment.Skills}, {"mcp", w.Snapshot.Environment.Servers}, {"execution-profile", w.Snapshot.Environment.ExecutionProfiles}, {"grant", w.Snapshot.Environment.Grants}} {
		for _, ref := range group.refs {
			var count int
			if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", group.kind, ref.ID, ref.Revision).Scan(&count); err != nil {
				return storageFailure(err)
			}
			if count > 0 {
				return &Error{409, "capability-revoked", "流程固定环境包含已撤销授权，不能继续执行"}
			}
		}
	}
	return nil
}
func (m *Manager) workflowAllowedActions(ctx context.Context, w WorkflowInstance) []string {
	if workflowV2(w) {
		return m.workflowV2AllowedActions(ctx, w)
	}
	out := []string{}
	if w.Status != StateRecoveryRequired || w.CancelRequestedAt != "" {
		return out
	}
	if w.Usage.ActiveMilliseconds+w.Usage.ReservedMilliseconds >= w.Limits.ActiveMilliseconds || w.Usage.Tokens >= w.Limits.Tokens || w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes >= w.Limits.ResultBytes {
		return out
	}
	var count int
	if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE state IN ('dispatched','unknown')").Scan(&count); err != nil || count > 0 {
		return out
	}
	if m.checkWorkflowEnvironment(ctx, w) != nil {
		return out
	}
	if validateWorkflowV1RecoverySources(ctx, m.store.db, w) != nil {
		return out
	}
	if w.ActiveRunID == "" {
		if w.Error != nil && w.Error.Code == "maintenance-recovery" {
			return []string{"continue"}
		}
		return out
	}
	r, err := readRun(ctx, m.store.db, w.ActiveRunID)
	if err != nil || m.executionLocked(r.ID) != nil {
		return out
	}
	approvals, err := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", r.ID)
	if err != nil {
		return out
	}
	if !terminal(r.Status) {
		if r.WorkflowFrozenFrom == StateQueued && len(approvals) == 0 {
			if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM operations WHERE run_id=?", r.ID).Scan(&count); err == nil && count == 0 {
				out = append(out, "continue")
			}
		}
		if len(approvals) > 0 {
			out = append(out, "renew-approval")
		}
		return out
	}
	a, err := readWorkflowAttempt(ctx, m.store.db, r.ID)
	if err != nil || a.Status == StateSucceeded {
		return out
	}
	if r.WorkflowAttempt < w.Limits.Attempts {
		out = append(out, "retry")
	}
	if workflowDriver(r) == "agent" || workflowDriver(r) == "operation" {
		barriers, e := readDocuments[ExecutionBarrier](ctx, m.store.db, "SELECT document FROM execution_barriers WHERE run_id=?", r.ID)
		if e != nil {
			return out
		}
		for _, b := range barriers {
			if b.Status == "reconciled" && b.Decision != "confirmed-completed" {
				return out
			}
		}
		out = append(out, "accept-result")
	}
	return out
}
