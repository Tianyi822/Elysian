package harness

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/jsonvalue"
)

func methodKey(tool string, args json.RawMessage) (string, string) {
	var input map[string]any
	_ = json.Unmarshal(args, &input)
	target := tool
	for _, field := range []string{"id", "name", "target"} {
		if value, ok := input[field].(string); ok && value != "" {
			target = value
			break
		}
	}
	fingerprint, _ := jsonvalue.RecoveryFingerprint(args)
	return target + "|" + tool + ":" + fingerprint, target
}

// The method quarantine is rebuilt from committed receipts, not model claims.
// Novel successful evidence for the same target releases its old quarantine.
func (a *agentExecution) continuousProgress(ctx context.Context, calls []Call) error {
	counts := map[string]int{}
	methods := map[string]BlockedMethod{}
	seen := map[string]bool{}
	for _, call := range calls {
		if call.Tool == toolSearchName || call.Tool == planTool || call.Tool == userInputTool || call.Tool == taskHistoryTool {
			continue
		}
		args := json.RawMessage(call.ArgumentsJSON)
		if len(args) == 0 {
			args, _ = json.Marshal(call.Args)
		}
		key, target := methodKey(call.Tool, args)
		if call.Status == StateSucceeded {
			evidence := key + ":" + hstate.DigestJSON(call.Result)
			if !seen[evidence] {
				for failed, method := range methods {
					if method.Target == target {
						delete(counts, failed)
						delete(methods, failed)
					}
				}
				seen[evidence] = true
			}
		} else if call.Status == StateFailed && call.Error != nil {
			failureKey := key + ":" + call.Error.Code
			attempts := max(1, len(call.Attempts))
			counts[failureKey] += attempts
			methods[failureKey] = BlockedMethod{Key: key, Target: target, Tool: call.Tool, Reason: call.Error.Message}
		}
	}
	blocked := []BlockedMethod{}
	for key, count := range counts {
		if count >= 3 {
			blocked = append(blocked, methods[key])
		}
	}
	sortBlockedMethods(blocked)
	m := a.manager
	current, err := readView(ctx, m.store).Get(ctx, a.run.ID)
	if err != nil {
		return err
	}
	if len(blocked) == 0 && (current.Diagnosis == nil || len(current.Diagnosis.Methods) == 0) {
		return nil
	}
	rounds := 0
	if current.Diagnosis != nil && hstate.DigestJSON(current.Diagnosis.Methods) == hstate.DigestJSON(blocked) {
		rounds = current.Diagnosis.Rounds
		if current.Usage.ModelRequests > current.Diagnosis.LastRequest {
			rounds++
		}
	}
	if len(blocked) == 0 {
		rounds = 0
	}
	if rounds >= 3 {
		return bad("no-progress", "已完成三轮诊断，仍未取得相关新证据；已停止重复方法，执行事实与未完成计划已保存")
	}
	_, err = m.store.ChangeRun(ctx, a.run.ID, "diagnosis-checkpoint", func(tx sessionstore.Tx, r *Run) error {
		if len(blocked) == 0 {
			r.Diagnosis = nil
		} else {
			r.Diagnosis = &RunDiagnosis{Methods: blocked, Rounds: rounds, LastRequest: r.Usage.ModelRequests, Message: "相同方法已无进展，禁止按原参数重复；请诊断原因、读取相关新事实或更换方案，在现有权限内继续完成目标"}
		}
		a.run.Diagnosis = r.Diagnosis
		return tx.Event(ctx, r, "recovery/diagnosing", "", nil, r.Diagnosis)
	})
	return err
}

func (a *agentExecution) diagnoseModelFailure(ctx context.Context, key, message string) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.store.ChangeRun(ctx, a.run.ID, "protocol-diagnosis", func(tx sessionstore.Tx, r *Run) error {
		if r.Diagnosis == nil {
			r.Diagnosis = &RunDiagnosis{Methods: []BlockedMethod{}}
		}
		r.Diagnosis.Rounds++
		if r.Diagnosis.Rounds > 3 {
			return bad("no-progress", "工具提议经过三轮诊断仍未取得新证据，未派发任何被拒绝的调用；"+message)
		}
		r.Diagnosis.LastRequest = r.Usage.ModelRequests
		r.Diagnosis.Message = "该完整提议已整批拒绝且未执行；停止重复相同提议，检查工具定义、改用相关只读诊断或调整方法。原因：" + message
		a.run.Diagnosis = r.Diagnosis
		return tx.Event(ctx, r, "recovery/protocol-diagnosing", "", nil, map[string]any{"key": key, "diagnosis": r.Diagnosis})
	})
	return err
}

func blockedProposal(r Run, tool string, args json.RawMessage) bool {
	if r.Diagnosis == nil {
		return false
	}
	key, _ := methodKey(tool, args)
	for _, method := range r.Diagnosis.Methods {
		if key == method.Key {
			return true
		}
	}
	return false
}

func (a *agentExecution) completionReady(ctx context.Context) (bool, error) {
	if !hstate.ContinuousRun(a.run) {
		return true, nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	r, err := readView(ctx, m.store).Get(ctx, a.run.ID)
	if err != nil {
		return false, err
	}
	unsettled, err := unsettledRun(ctx, m.store, r.ID)
	if err != nil {
		return false, err
	}
	if unsettled {
		return false, bad("outcome-unknown", "结束核对发现尚未结清的操作，须先核实实际结果，不能重复执行")
	}
	var pending []string
	if r.Plan != nil {
		for _, step := range r.Plan.Steps {
			if step.Status != "completed" {
				pending = append(pending, step.Title)
			}
		}
	}
	if len(pending) == 0 {
		return true, nil
	}
	if r.CompletionChecks >= 3 {
		return false, bad("goal-incomplete", "模型多次请求结束，但计划仍有未完成事项："+strings.Join(pending, "；"))
	}
	_, err = m.store.ChangeRun(ctx, r.ID, "completion-check", func(tx sessionstore.Tx, r *Run) error {
		r.CompletionChecks++
		a.run.CompletionChecks = r.CompletionChecks
		return tx.Event(ctx, r, "recovery/completion-check", "", nil, map[string]any{"remaining": pending})
	})
	return false, err
}

func sortBlockedMethods(methods []BlockedMethod) {
	sort.Slice(methods, func(i, j int) bool { return methods[i].Key < methods[j].Key })
}
