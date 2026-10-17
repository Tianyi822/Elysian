package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const planTool = "update_plan"
const planSource = "task-plan"

type PlanStep struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// RunPlan 是模型确认的步骤快照，不代表外部操作已获授权或执行成功。
type RunPlan struct {
	Revision  int        `json:"revision"`
	UpdatedAt string     `json:"updatedAt"`
	Steps     []PlanStep `json:"steps"`
}

func planCapability() Capability {
	return Capability{Name: planTool, Source: planSource, ReadOnly: true,
		Description: "规划并更新当前轮复杂任务的进度。提交完整的有序步骤列表，保留仍属同一步骤的稳定 ID；状态为 pending、in_progress 或 completed，最多一个进行中。简单问答无需计划。根据新发现可增删或调整步骤，开始执行及确认完成时更新；只有结果已确认才标记完成，最终答复前核对。计划不授予执行权限。",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"steps":{"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":64},"title":{"type":"string","minLength":1,"maxLength":200},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["id","title","status"],"additionalProperties":false}}},"required":["steps"],"additionalProperties":false}`),
		Metadata:    tools.Metadata{Domain: "agent", Action: "update-plan", Effect: "read", ReadOnly: true, Exposure: "agent", Version: "1"}}
}

func parsePlan(raw json.RawMessage) ([]PlanStep, error) {
	if err := mcp.Validate(planCapability().Parameters, raw); err != nil {
		return nil, bad("invalid-plan", "计划须包含 1–20 个步骤，每步提供编号、最多 200 字的名称及 pending、in_progress 或 completed 状态")
	}
	var args struct {
		Steps []PlanStep `json:"steps"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, bad("invalid-plan", "任务计划格式无效")
	}
	ids := map[string]bool{}
	active := 0
	for i := range args.Steps {
		step := &args.Steps[i]
		step.Title = strings.TrimSpace(step.Title)
		if !requestPattern.MatchString(step.ID) || ids[step.ID] || step.Title == "" {
			return nil, bad("invalid-plan", "步骤编号必须有效且唯一，步骤名称不能为空")
		}
		ids[step.ID] = true
		if step.Status == "in_progress" {
			active++
		}
	}
	if active > 1 {
		return nil, bad("invalid-plan", "同一时间最多一个步骤进行中")
	}
	return args.Steps, nil
}

func (a *agentExecution) validatePlanAccess(record ModelRequestRecord) error {
	c, ok := a.capability(planTool)
	if a.run.DriverVersion != "v2" || a.run.WorkflowID != "" || !ok || c.Source != planSource {
		return bad("tool-denied", "该运行不支持任务规划")
	}
	return a.validateVisibleProposal(record, planTool)
}

// 计划、回执和恢复游标一起提交。没有外部操作，不申请资源租约或审批。
func (a *agentExecution) executePlan(ctx context.Context, index int, proposal model.ToolCall) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError || ctx.Err() != nil || m.store.recordsFault() != nil {
		return context.Canceled
	}
	if err := a.validatePlanAccess(*a.pending); err != nil {
		return err
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return err
		}
	}
	_, err := m.store.change(ctx, a.run.ID, "update-plan", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		var raw string
		err := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE run_id=? AND json_extract(document,'$.modelRequestId')=? AND json_extract(document,'$.modelCallId')=?", r.ID, a.pending.ID, proposal.ID).Scan(&raw)
		if err == nil {
			var existing Call
			if err := json.Unmarshal([]byte(raw), &existing); err != nil {
				return err
			}
			if existing.Tool != planTool || existing.ArgumentsJSON != string(proposal.Arguments) {
				return bad("invalid-worker-call", "计划回执与原工具调用不一致")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if r.Usage.Calls >= r.Limits.MaxSteps {
			return bad("call-limit", "工具调用次数已达上限")
		}
		now := stamp(m.deps.Now())
		call := Call{ID: m.deps.NewID(), RunID: r.ID, Tool: planTool, ModelRequestID: a.pending.ID, ModelCallID: proposal.ID,
			ArgumentsJSON: string(proposal.Arguments), StepIndex: r.Usage.Calls, StartedAt: now, EndedAt: now, Status: StateSucceeded}
		steps, invalid := parsePlan(proposal.Arguments)
		if invalid != nil {
			call.Status = StateFailed
			call.Error = &Failure{Code: "invalid-plan", Message: invalid.Error()}
		} else {
			revision := 1
			if r.Plan != nil {
				revision = r.Plan.Revision + 1
			}
			r.Plan = &RunPlan{Revision: revision, UpdatedAt: now, Steps: steps}
			call.Result, _ = json.Marshal(r.Plan)
			if len(call.Result) > r.Limits.ResultBytes || r.Usage.ResultBytes+len(call.Result) > r.Limits.RunResultBytes {
				return bad("result-limit", "计划超过本轮结果容量限制")
			}
			r.Usage.ResultBytes += len(call.Result)
		}
		r.Usage.Calls++
		r.Resume = &RecoveryCursor{ResponseID: a.pending.ID, CallIndex: index + 1}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return m.store.event(ctx, tx, r, "plan/update", call.ID, &call.StepIndex, nil)
	})
	if err != nil {
		if _, ok := err.(*Error); !ok && !errors.Is(err, context.Canceled) && ctx.Err() == nil {
			m.storageFailedLocked()
		}
		return storageFailure(err)
	}
	return nil
}
