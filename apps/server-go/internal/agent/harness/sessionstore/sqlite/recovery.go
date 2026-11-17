package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"elysian/server/internal/agent/harness/state"
)

func (s *store) list(ctx context.Context, q ListQuery) (Page[Run], error) {
	return storeRead(ctx, s, "list", func(ctx context.Context) (Page[Run], error) {
		p := Page[Run]{Items: []Run{}}
		limit, err := state.PageSize(q.Limit, 50)
		if err != nil {
			return p, err
		}
		cursor, err := state.NumberCursor(q.Cursor)
		if err != nil {
			return p, err
		}
		if q.Status != "" && !state.ValidState(q.Status) {
			return p, &Error{Status: 400, Code: "invalid-state", Message: "运行状态无效"}
		}
		rows, err := s.reader(ctx).QueryContext(ctx, `SELECT runs.rowid,runs.document FROM runs
 WHERE (?='' OR runs.state=?) AND (?='' OR runs.request_id=?) AND (?='' OR runs.session_id=?) AND (?='' OR runs.task_id=?)
 AND (?='' OR runs.workflow_id=?) AND (?=0 OR runs.rowid<?) ORDER BY runs.rowid DESC LIMIT ?`, q.Status, q.Status, q.RequestID, q.RequestID, q.SessionID, q.SessionID, q.TaskID, q.TaskID, q.WorkflowID, q.WorkflowID, cursor, cursor, limit+1)
		if err != nil {
			return p, err
		}
		defer rows.Close()
		var last int64
		for rows.Next() {
			var id int64
			var raw string
			var r Run
			if err = rows.Scan(&id, &raw); err != nil {
				return p, err
			}
			if len(p.Items) == limit {
				p.HasMore = true
				break
			}
			if err = json.Unmarshal([]byte(raw), &r); err != nil {
				return p, err
			}
			p.Items = append(p.Items, r)
			last = id
		}
		if p.HasMore {
			p.NextCursor = strconv.FormatInt(last, 10)
		}
		return p, rows.Err()
	})
}

func (s *store) calls(ctx context.Context, id, rawCursor string, n int) (Page[Call], error) {
	return storeRead(ctx, s, "calls", func(ctx context.Context) (Page[Call], error) {
		p := Page[Call]{Items: []Call{}}
		limit, err := state.PageSize(n, 50)
		if err != nil {
			return p, err
		}
		cursor, err := state.NumberCursor(rawCursor)
		if err != nil {
			return p, err
		}
		if _, err = readRun(ctx, s.reader(ctx), id); err != nil {
			return p, err
		}
		rows, err := s.reader(ctx).QueryContext(ctx, "SELECT step_index,document FROM calls WHERE run_id=? AND step_index>=? ORDER BY step_index LIMIT ?", id, cursor, limit+1)
		if err != nil {
			return p, err
		}
		defer rows.Close()
		last := int64(0)
		for rows.Next() {
			var index int64
			var raw string
			var c Call
			if err = rows.Scan(&index, &raw); err != nil {
				return p, err
			}
			if len(p.Items) == limit {
				p.HasMore = true
				break
			}
			if err = json.Unmarshal([]byte(raw), &c); err != nil {
				return p, err
			}
			p.Items = append(p.Items, c)
			last = index + 1
		}
		if p.HasMore {
			p.NextCursor = strconv.FormatInt(last, 10)
		}
		return p, rows.Err()
	})
}

func (s *store) events(ctx context.Context, id, after string, n int) (Page[Event], error) {
	return storeRead(ctx, s, "events", func(ctx context.Context) (Page[Event], error) {
		p := Page[Event]{Items: []Event{}}
		limit, err := state.PageSize(n, 100)
		if err != nil {
			return p, err
		}
		cursor, err := state.NumberCursor(after)
		if err != nil {
			return p, err
		}
		r, err := readRun(ctx, s.reader(ctx), id)
		if err != nil {
			return p, err
		}
		last, _ := strconv.ParseInt(r.LastSeq, 10, 64)
		if cursor > last {
			return p, &Error{Status: 400, Code: "future-cursor", Message: "事件游标超过当前运行进度"}
		}
		rows, err := s.reader(ctx).QueryContext(ctx, "SELECT document FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?", id, cursor, limit+1)
		if err != nil {
			return p, err
		}
		defer rows.Close()
		p.NextCursor = strconv.FormatInt(cursor, 10)
		for rows.Next() {
			var raw string
			var e Event
			if err = rows.Scan(&raw); err != nil {
				return p, err
			}
			if len(p.Items) == limit {
				p.HasMore = true
				break
			}
			if err = json.Unmarshal([]byte(raw), &e); err != nil {
				return p, err
			}
			p.Items = append(p.Items, e)
			p.NextCursor = e.Seq
		}
		return p, rows.Err()
	})
}

var bad = state.Bad

func prepareContinuation(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.Selection == nil || r.Selection.ContinueFromRunID == "" {
		return nil
	}
	source, err := readRun(ctx, tx, r.Selection.ContinueFromRunID)
	if err != nil {
		if isNotFound(err) {
			return &Error{Status: 409, Code: "continuation-changed", Message: "原轮次已不存在，请刷新会话"}
		}
		return err
	}
	if source.TaskID != r.TaskID || source.SessionID != r.SessionID || !state.BudgetContinuationCandidate(source) {
		return &Error{Status: 409, Code: "continuation-changed", Message: "原轮次不再支持继续，请刷新会话"}
	}
	state, err := continuation(ctx, tx, source)
	if err != nil {
		return err
	}
	if !state.Allowed {
		return &Error{Status: 409, Code: "continuation-blocked", Message: state.BlockedReason}
	}
	if source.Plan != nil {
		plan := &RunPlan{SourceRunID: source.ID, Revision: 1, UpdatedAt: r.CreatedAt, Steps: append([]PlanStep(nil), source.Plan.Steps...)}
		for i := range plan.Steps {
			if plan.Steps[i].Status == "in_progress" {
				plan.Steps[i].Status = "pending"
			}
		}
		r.Plan = plan
	}
	return nil
}

type BudgetStop = state.BudgetStop

type Continuation = state.Continuation

// continuation 与接受事务共用判定，避免客户端把过期按钮或未知回执解释成授权。
func continuation(ctx context.Context, q recoveryReader, r Run) (*Continuation, error) {
	if !state.BudgetContinuationCandidate(r) {
		return nil, nil
	}
	out := &Continuation{SourceRunID: r.ID}
	var latest string
	if err := q.QueryRowContext(ctx, `SELECT id FROM runs WHERE session_id=? AND COALESCE(json_extract(document,'$.supersededByRunId'),'')='' ORDER BY rowid DESC LIMIT 1`, r.SessionID).Scan(&latest); err != nil {
		return nil, err
	}
	if latest != r.ID {
		out.BlockedReason = "会话已有新轮次，请刷新后继续"
		return out, nil
	}
	session, err := readSession(ctx, q, r.SessionID)
	if err != nil {
		return nil, err
	}
	var unknown bool
	if err := q.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.session_id=? AND (o.state IN ('dispatched','waiting-task') OR (o.state='unknown' AND NOT EXISTS(SELECT 1 FROM execution_barriers settled WHERE settled.operation_id=o.id AND settled.state='reconciled')))) OR
 EXISTS(SELECT 1 FROM execution_barriers b JOIN runs r ON r.id=b.run_id WHERE r.session_id=? AND b.state IN ('dispatched','unknown')) OR
 EXISTS(SELECT 1 FROM resource_leases l JOIN runs r ON r.id=l.run_id WHERE r.session_id=? AND l.state IN ('held','unknown')) OR
 EXISTS(SELECT 1 FROM calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? AND c.state IN ('running','interrupted','recovery-required') AND NOT EXISTS(SELECT 1 FROM execution_barriers b WHERE b.operation_id=json_extract(c.document,'$.operationId') AND b.state='reconciled'))`, r.SessionID, r.SessionID, r.SessionID, r.SessionID).Scan(&unknown); err != nil {
		return nil, err
	}
	if !unknown {
		if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM operations o JOIN resource_leases l ON l.operation_id=json_extract(o.document,'$.resourceWait.operationId') WHERE o.run_id=? AND l.state IN ('held','unknown')) OR EXISTS(SELECT 1 FROM operations o JOIN execution_barriers b ON b.operation_id=json_extract(o.document,'$.resourceWait.operationId') WHERE o.run_id=? AND b.state IN ('dispatched','unknown'))`, r.ID, r.ID).Scan(&unknown); err != nil {
			return nil, err
		}
	}
	if !unknown {
		blockers, err := currentBlockingRecovery(ctx, q, r.ID)
		if err != nil {
			return nil, err
		}
		unknown = len(blockers) != 0
	}
	if unknown {
		out.BlockedReason = "存在结果未知或尚未释放的操作，请先核实实际状态"
	} else if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		out.BlockedReason = "会话仍有任务运行，请等待结束"
	} else {
		out.Allowed = true
	}
	return out, nil
}

const continuousBudgetPolicy = "resource-budget/v2"

type recoveryReader interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// Use the same live protection set for the timeline and continuation. Historical
// wait records retain their original source even after that source is settled.
func currentBlockingRecovery(ctx context.Context, db recoveryReader, runID string) ([]BlockingRecovery, error) {
	result := []BlockingRecovery{}
	waiters, err := readDocuments[Operation](ctx, db, `SELECT document FROM operations WHERE run_id=? AND json_extract(document,'$.resourceWait.unknown')=1`, runID)
	if err != nil {
		return nil, err
	}
	if len(waiters) == 0 {
		return result, nil
	}
	barriers, err := readDocuments[ExecutionBarrier](ctx, db, "SELECT document FROM execution_barriers WHERE state='unknown'")
	if err != nil {
		return nil, err
	}
	leases, err := readDocuments[ResourceLease](ctx, db, "SELECT document FROM resource_leases WHERE state='unknown'")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	add := func(runID, operationID, leaseID string) {
		key := operationID
		if key == "" {
			key = "lease:" + leaseID
		}
		if !seen[key] {
			seen[key] = true
			result = append(result, BlockingRecovery{RunID: runID, OperationID: operationID, LeaseID: leaseID})
		}
	}
	for _, waiter := range waiters {
		taskControl := waiter.Capability.Metadata.Async && waiter.Capability.Metadata.Action == "cancel" && waiter.Capability.Metadata.TaskDomain != "" && waiter.Capability.Metadata.TaskIDArgument != ""
		// Older global waiters may have stored a concrete conflicting resource.
		globalFence := waiter.ResourceWait.Resource == "external:*" || state.ExternalOperation(waiter) && !taskControl
		for _, barrier := range barriers {
			if globalFence || barrier.OperationID == waiter.ResourceWait.OperationID {
				add(barrier.RunID, barrier.OperationID, "")
			}
		}
		for _, lease := range leases {
			if globalFence || state.ResourceSetsConflict(waiter.ResourceClaims, lease.Claims) {
				leaseID := ""
				if lease.OperationID == "" {
					leaseID = lease.ID
				}
				add(lease.RunID, lease.OperationID, leaseID)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].RunID == result[j].RunID {
			return result[i].OperationID < result[j].OperationID
		}
		return result[i].RunID < result[j].RunID
	})
	return result, nil
}

type BlockingRecovery = state.BlockingRecovery

// Recover only a proven checkpoint. Unknown tools retain their original
// identities and are left to the existing domain reconciliation monitor.
func (s *store) recoverContinuous(ctx context.Context, tx *sql.Tx, r *Run) (bool, error) {
	if !state.ContinuousRun(*r) || state.Terminal(r.Status) || r.PolicyFrozen || r.CancelRequestedAt != "" || r.SupersededByRunID != "" {
		return false, nil
	}
	session, err := readSession(ctx, tx, r.SessionID)
	if err != nil {
		return false, err
	}
	if session.ActiveRunID != r.ID {
		return false, nil
	}
	unsettled, err := unsettledRun(ctx, tx, r.ID)
	if err != nil {
		return false, err
	}
	if unsettled {
		r.Status, r.Phase = StateRecoveryRequired, "recovering"
		r.Error = &Failure{Code: "recovery-evidence-required", Message: "仍有未结执行保护，已暂停派发并等待可信结束证据"}
		operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE run_id=? AND state IN ('unknown','waiting-task','dispatched')", r.ID)
		if err != nil {
			return false, err
		}
		for _, operation := range operations {
			state.BeginRecovery(r, &operation, s.now())
			if err = saveOperation(ctx, tx, operation); err != nil {
				return false, err
			}
		}
		if err = interruptCalls(ctx, tx, r.ID, s.now()); err != nil {
			return false, err
		}
		if err = s.event(ctx, tx, r, "recovery/restarted-verification", "", nil, r.Recovery); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := interruptModelRequests(ctx, tx, r.ID, s.now()); err != nil {
		return false, err
	}
	r.Status, r.Phase = StateQueued, "recovering"
	r.EndReason, r.EndedAt, r.Error = "", "", nil
	if err := s.event(ctx, tx, r, "recovery/restarted", "", nil, map[string]string{"message": "已核对执行检查点，沿用原任务与请求身份继续"}); err != nil {
		return false, err
	}
	return true, nil
}

func (s *store) freezeContinuousRuns(ctx context.Context, tx *sql.Tx) error {
	if !s.freezeContinuous {
		return nil
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')")
	if err != nil {
		return err
	}
	for _, r := range runs {
		if state.ContinuousRun(r) && !r.PolicyFrozen {
			r.PolicyCheckpoint = &PolicyCheckpoint{Status: r.Status, Phase: r.Phase, Error: r.Error}
			r.PolicyFrozen = true
			r.Status, r.Phase = StateRecoveryRequired, "policy-frozen"
			r.Error = &Failure{Code: "continuous-policy-frozen", Message: "兼容回滚已冻结持续执行策略，保留执行事实与保护；请恢复支持该策略的版本后核实"}
			if err = s.event(ctx, tx, &r, "recovery/policy-frozen", "", nil, r.Error); err != nil {
				return err
			}
		}
	}
	return nil
}

// A supporting build may unfreeze scheduling only after validating the same
// active Run and its durable execution protection. Terminal/cancelled history
// remains frozen; no operation is resubmitted by this transition.
func (s *store) thawContinuousRuns(ctx context.Context, tx *sql.Tx) error {
	if s.freezeContinuous {
		return nil
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE state='recovery-required' AND json_extract(document,'$.policyFrozen')=1")
	if err != nil {
		return err
	}
	for _, r := range runs {
		if !state.ContinuousRun(r) || r.CancelRequestedAt != "" || r.SupersededByRunID != "" || r.PolicyCheckpoint == nil {
			continue
		}
		session, err := readSession(ctx, tx, r.SessionID)
		if err != nil {
			return err
		}
		if session.ActiveRunID != r.ID {
			continue
		}
		checkpoint := r.PolicyCheckpoint
		r.PolicyFrozen, r.PolicyCheckpoint = false, nil
		r.Status, r.Phase, r.Error = checkpoint.Status, checkpoint.Phase, checkpoint.Error
		unknown, err := unsettledRun(ctx, tx, r.ID)
		if err != nil {
			return err
		}
		if unknown || r.Status == StateRunning || r.Status == StateQueued || r.Status == StateWaitingTask || r.Status == StateWaitingRecovery {
			if _, err = s.recoverContinuous(ctx, tx, &r); err != nil {
				return err
			}
		}
		if err = s.event(ctx, tx, &r, "recovery/policy-restored", "", nil, map[string]string{"message": "已核对原任务身份与执行保护，恢复支持版本的调度策略"}); err != nil {
			return err
		}
	}
	return nil
}

type PolicyCheckpoint = state.PolicyCheckpoint

func unsettledRun(ctx context.Context, q rowReader, id string) (bool, error) {
	var unsettled bool
	err := q.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM execution_barriers WHERE run_id=? AND state IN ('dispatched','unknown')) OR
 EXISTS(SELECT 1 FROM resource_leases WHERE run_id=? AND state IN ('held','unknown')) OR
 EXISTS(SELECT 1 FROM operations WHERE run_id=? AND state IN ('dispatched','unknown','waiting-task'))`, id, id, id).Scan(&unsettled)
	return unsettled, err
}

type RunWait = state.RunWait

const planTool = "update_plan"

type PlanStep = state.PlanStep

type RunPlan = state.RunPlan

const recoveryWindow = 2 * time.Minute

type RunRecovery = state.RunRecovery

const evidenceRecoveryPolicy = "evidence-recovery/v1"

const continuousRecoveryPolicy = "evidence-recovery/v2"

type ToolAttempt = state.ToolAttempt

const (
	toolSearchName      = "tool_search"
	toolDiscoverySource = "tool-discovery"
	onDemandTools       = "on-demand/v1"
	eagerToolLimit      = 16
	maxLoadedTools      = 16
	maxDiscoveryCatalog = 512
)

const taskHistoryTool = "task_history"
