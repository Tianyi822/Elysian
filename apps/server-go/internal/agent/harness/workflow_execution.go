package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"encoding/json"
	"errors"
	"time"
)

func nullableWorkflowString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func latestMemory(ctx context.Context, q workflowQuery, task string) (WorkingMemory, error) {
	var v WorkingMemory
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM working_memories WHERE task_id=? ORDER BY revision DESC LIMIT 1", task).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, nil
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &v)
	}
	return v, err
}
func (m *Manager) executeWorkflowStep(ctx context.Context, r Run) error {
	m.mu.Lock()
	w, step, err := m.workflowDefinitionForRun(ctx, r)
	m.mu.Unlock()
	if err != nil {
		return err
	}
	if step.Kind == "operation" {
		a := &agentExecution{manager: m, run: r}
		return a.executeOperation(ctx, 0, model.ToolCall{Name: step.Capability}, json.RawMessage(r.Input))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	err = m.store.write(ctx, "workflow-control", func(tx *sql.Tx) error {
		current, e := readRun(ctx, tx, r.ID)
		if e != nil {
			return e
		}
		if current.CancelRequestedAt != "" || ctx.Err() != nil {
			return context.Canceled
		}
		if step.Kind == "approval" {
			approvals, e := readApprovalTx(ctx, tx, r.ID)
			if e != nil {
				return e
			}
			if len(approvals) > 0 {
				for _, a := range approvals {
					if a.Status == "approved" && !approvalExpired(a, m.deps.Now()) {
						if a.ContentDigest != workflowGateDigest(w, step, r.Input) {
							return bad("approval-invalid", "流程确认内容发生变化")
						}
						a.Status = "consumed"
						if e = saveApproval(ctx, tx, a); e != nil {
							return e
						}
						current.WorkflowOutputJSON = `{"approved":true}`
					}
				}
				if current.WorkflowOutputJSON == "" {
					return bad("approval-invalid", "流程确认尚未批准或已经失效")
				}
			} else {
				var count int
				if e = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(&count); e != nil {
					return e
				}
				if count >= 32 {
					return &Error{429, "approvals-full", "待审批运行已达上限"}
				}
				a := Approval{ID: m.deps.NewID(), RunID: r.ID, Kind: "workflow-gate", WorkflowID: w.ID, WorkflowStepID: step.ID, WorkflowAttempt: r.WorkflowAttempt, Status: "pending", CreatedAt: stamp(m.deps.Now()), ExpiresAt: stamp(m.deps.Now().Add(24 * time.Hour)), ContentDigest: workflowGateDigest(w, step, r.Input), Instruction: step.Instruction, InputJSON: r.Input}
				a.ScopeID, a.NodeID = r.ScopeID, r.NodeID
				if e = saveApproval(ctx, tx, a); e != nil {
					return e
				}
				current.Status = StateWaitingApproval
				current.Phase = StateWaitingApproval
				return m.store.event(ctx, tx, &current, "approval/request", "", nil, map[string]string{"approvalId": a.ID})
			}
		} else if step.Kind == "condition" {
			outputs, e := workflowOutputs(ctx, tx, w.ID)
			input := w.InputJSON
			if workflowV2(w) {
				scope, _, _, err := workflowV2StepForRun(ctx, tx, r)
				if err != nil {
					return err
				}
				input = scope.InputJSON
				outputs, e = workflowScopeOutputs(ctx, tx, scope.ID)
			}
			if e != nil {
				return e
			}
			matched, e := evaluateWorkflowCondition(*step.Condition, input, outputs)
			if e != nil {
				return e
			}
			current.WorkflowOutputJSON = `{"matched":false}`
			current.WorkflowNext = step.Else
			if matched {
				current.WorkflowOutputJSON = `{"matched":true}`
				current.WorkflowNext = step.Then
			}
		} else {
			return bad("workflow-kind", "工作流步骤类型无效")
		}
		if e = validateWorkflowJSON(step.OutputSchemaJSON, current.WorkflowOutputJSON); e != nil {
			return e
		}
		current.Status = StateSucceeded
		current.EndedAt = stamp(m.deps.Now())
		current.EndReason = "completed"
		if e = m.store.event(ctx, tx, &current, "run/succeeded", "", nil, nil); e != nil {
			return e
		}
		return m.store.releaseSession(ctx, tx, &current)
	})
	if err != nil {
		return err
	}
	run, e := readRun(ctx, m.store.db, r.ID)
	if e != nil {
		return e
	}
	if run.Status == StateWaitingApproval {
		return worker.ErrSuspended
	}
	return nil
}
func workflowGateDigest(w WorkflowInstance, step WorkflowStepDefinition, input string) string {
	return digestJSON(struct {
		WorkflowID string
		Revision   int
		Step       WorkflowStepDefinition
		Input      string
		Snapshot   string
	}{w.ID, w.DefinitionRevision, step, input, w.Snapshot.Digest})
}
func (m *Manager) workflowContextFacts(ctx context.Context, r Run) ([]factGroup, error) {
	attempts, err := readDocuments[WorkflowAttempt](ctx, m.store.db, "SELECT document FROM workflow_attempts WHERE workflow_id=? AND state='succeeded' ORDER BY rowid", r.WorkflowID)
	if err != nil {
		return nil, err
	}
	// v2 的 attempt 主键按节点维度唯一（同名步骤在并行分支与迭代中是多个节点），
	// 展示给模型的步骤来源要换回节点对应的步骤定义 ID，不能暴露节点 UUID。
	nodeSteps := map[string]string{}
	for _, a := range attempts {
		if a.NodeID == "" {
			continue
		}
		if _, ok := nodeSteps[a.NodeID]; ok {
			continue
		}
		var raw string
		if e := m.store.db.QueryRowContext(ctx, "SELECT document FROM workflow_nodes WHERE id=?", a.NodeID).Scan(&raw); e != nil {
			return nil, e
		}
		var node WorkflowNodeExecution
		if e := json.Unmarshal([]byte(raw), &node); e != nil {
			return nil, e
		}
		nodeSteps[a.NodeID] = node.StepID
	}
	out := []factGroup{}
	for _, a := range attempts {
		if r.ScopeID != "" && a.ScopeID != r.ScopeID {
			continue
		}
		invalid, e := wikiArtifactInvalid(ctx, m.store.db, "run", a.RunID)
		if e != nil {
			return nil, e
		}
		if invalid {
			continue
		}
		if a.RunNumber >= r.RunNumber {
			continue
		}
		value, e := workflowOutput(ctx, m.store.db, a)
		if e != nil {
			return nil, e
		}
		stepLabel := a.StepID
		if a.NodeID != "" {
			stepLabel = nodeSteps[a.NodeID]
		}
		ref := EvidenceRef{RunID: a.RunID, EventSeq: a.EventSeq}
		content := "流程步骤 " + stepLabel + " 完成资料（来源 " + refKey(ref) + "；完成方式 " + a.CompletionSource + "）：\n" + value
		if a.Evidence != "" {
			content += "\n人工核实证据：" + a.Evidence
		}
		out = append(out, factGroup{cursor: MemoryCursor{RunNumber: a.RunNumber, EventSeq: a.EventSeq}, refs: []EvidenceRef{ref}, messages: []model.Message{{Role: "user", Content: content}}})
	}
	return out, nil
}
