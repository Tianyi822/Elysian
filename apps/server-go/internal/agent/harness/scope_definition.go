package harness

import (
	"context"
	"encoding/json"
	"fmt"

	"elysian/server/internal/agent/harness/model"
)

// Validate each local graph with the v1 reachability/dominator checker. A
// composite is opaque to its parent: child facts can only escape via its output.
func validateWorkflowDefinitionV2(d WorkflowDefinition) error {
	raw, err := json.Marshal(d)
	if err != nil || len(raw) > 1<<20 {
		return workflowDefinitionError("工作流定义超过 1 MiB 上限或无法序列化")
	}
	staticNodes := 0
	var body func(WorkflowBody, int) error
	body = func(b WorkflowBody, depth int) error {
		staticNodes += len(b.Steps)
		if staticNodes > workflowV2MaxNodes {
			return workflowDefinitionError("模板静态节点总数不得超过 256")
		}
		if depth > workflowV2MaxDepth {
			return workflowDefinitionError("工作流嵌套深度不得超过 4")
		}
		clone := d
		clone.LanguageVersion = "v1"
		clone.InputSchemaJSON = `{"type":"object"}`
		clone.OutputSchemaJSON = b.OutputSchemaJSON
		clone.Entry = b.Entry
		clone.Steps = append([]WorkflowStepDefinition(nil), b.Steps...)
		for i, step := range b.Steps {
			count := 0
			if step.Parallel != nil {
				count++
			}
			if step.Foreach != nil {
				count++
			}
			if step.Subworkflow != nil {
				count++
			}
			switch step.Kind {
			case "parallel":
				if count != 1 || step.Parallel == nil || step.Parallel.Join != "all" || len(step.Parallel.Branches) < 1 || len(step.Parallel.Branches) > workflowV2MaxParallel {
					return workflowDefinitionError("parallel 必须声明 all 汇合与 1 至 8 个分支")
				}
				seen := map[string]bool{}
				for _, branch := range step.Parallel.Branches {
					if !workflowStepID.MatchString(branch.ID) || seen[branch.ID] {
						return workflowDefinitionError("parallel 分支标识必须有效且唯一")
					}
					seen[branch.ID] = true
					if err := validateWorkflowBinding(branch.Input, func(ref WorkflowOutputBinding) error {
						return workflowDefinitionError("分支输入只能引用该复合步骤的 input")
					}); err != nil {
						return err
					}
					if err := body(branch.Body, depth+1); err != nil {
						return err
					}
				}
			case "foreach":
				if count != 1 || step.Foreach == nil {
					return workflowDefinitionError("foreach 必须声明 items 和 body")
				}
				if err := validateWorkflowBinding(step.Foreach.Items, func(ref WorkflowOutputBinding) error {
					return workflowDefinitionError("foreach items 只能引用该复合步骤的 input")
				}); err != nil {
					return err
				}
				if err := body(step.Foreach.Body, depth+1); err != nil {
					return err
				}
			case "subworkflow":
				if count != 1 || step.Subworkflow == nil || step.Subworkflow.DefinitionID == "" || step.Subworkflow.DefinitionRevision < 1 {
					return workflowDefinitionError("子流程必须固定模板 ID 与正整数修订")
				}
			default:
				if count != 0 {
					return workflowDefinitionError("普通步骤不能包含复合步骤字段")
				}
				continue
			}
			if step.Instruction != "" || step.Capability != "" || step.Selection != nil {
				return workflowDefinitionError("复合步骤不能直接指定模型说明、能力或资料")
			}
			clone.Steps[i].Kind = "operation"
			clone.Steps[i].Capability = "composite"
			clone.Steps[i].Parallel = nil
			clone.Steps[i].Foreach = nil
			clone.Steps[i].Subworkflow = nil
		}
		return validateWorkflowDefinition(clone)
	}
	// Validate root schemas and fields without substituting its real input schema.
	if err := body(workflowBody(d), 0); err != nil {
		return err
	}
	if err := validateWorkflowJSON(d.InputSchemaJSON, "null"); err != nil {
		// Schema validity is independent from accepting the placeholder value.
		if typed, ok := err.(*Error); !ok || typed.Code != "workflow-schema-mismatch" {
			return err
		}
	}
	return nil
}

// Closure uses explicit revisions and rejects recursion even through older
// revisions of a template. Accepted instances keep complete immutable copies.
func workflowDefinitionClosure(ctx context.Context, q workflowQuery, root WorkflowDefinition) ([]WorkflowDefinition, error) {
	out := []WorkflowDefinition{}
	seen := map[string]bool{}
	stack := map[string]bool{}
	var visit func(WorkflowDefinition, int) error
	var walk func(WorkflowBody, int) error
	walk = func(b WorkflowBody, depth int) error {
		if depth > workflowV2MaxDepth {
			return workflowDefinitionError("模板闭包嵌套深度超过 4")
		}
		for _, step := range b.Steps {
			if step.Parallel != nil {
				for _, branch := range step.Parallel.Branches {
					if err := walk(branch.Body, depth+1); err != nil {
						return err
					}
				}
			}
			if step.Foreach != nil {
				if err := walk(step.Foreach.Body, depth+1); err != nil {
					return err
				}
			}
			if step.Subworkflow != nil {
				d, err := readWorkflowDefinition(ctx, q, step.Subworkflow.DefinitionID, step.Subworkflow.DefinitionRevision)
				if err != nil {
					return err
				}
				if !d.Enabled || d.LanguageVersion != WorkflowV2LanguageVersion {
					return workflowDefinitionError("子流程必须选择已启用的 workflow/v2 修订")
				}
				latest, err := readWorkflowDefinition(ctx, q, d.ID, 0)
				if err != nil {
					return err
				}
				if !latest.Enabled {
					return bad("workflow-disabled", "子流程模板最新修订已停用")
				}
				if err = visit(d, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	visit = func(d WorkflowDefinition, depth int) error {
		if stack[d.ID] {
			return workflowDefinitionError("子模板闭包禁止递归")
		}
		stack[d.ID] = true
		defer delete(stack, d.ID)
		if err := walk(workflowBody(d), depth); err != nil {
			return err
		}
		key := fmt.Sprintf("%s@%d", d.ID, d.Revision)
		if !seen[key] {
			seen[key] = true
			out = append(out, d)
		}
		if len(out) > workflowV2MaxNodes {
			return workflowDefinitionError("模板闭包过大")
		}
		return nil
	}
	if err := visit(root, 0); err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(out)
	if len(raw) > 4<<20 {
		return nil, workflowDefinitionError("模板闭包超过 4 MiB")
	}
	return out, nil
}

// The immutable definition closure is checked before accepting the instance.
// A nested branch has exactly the same capability boundary as a root leaf.
func (m *Manager) validateWorkflowCapabilities(snapshot CapabilitySnapshot, profile model.Profile, definitions []WorkflowDefinition) error {
	allowed := map[string]bool{}
	for _, group := range [][]Capability{snapshot.Tools, snapshot.Materials} {
		for _, capability := range group {
			allowed[capability.Name] = true
		}
	}
	var visit func(WorkflowBody) error
	visit = func(body WorkflowBody) error {
		for _, step := range body.Steps {
			if step.Selection != nil {
				if err := m.validateSelection(snapshot, *step.Selection); err != nil {
					return err
				}
			}
			if step.Kind == "agent" && (!profile.Capabilities.Text || !profile.Capabilities.Tools) {
				return bad("model-capability", "流程模型必须支持文本与函数调用")
			}
			if step.Kind == "operation" && !allowed[step.Capability] {
				return bad("tool-denied", "流程操作不在固定环境内")
			}
			if step.Parallel != nil {
				for _, branch := range step.Parallel.Branches {
					if err := visit(branch.Body); err != nil {
						return err
					}
				}
			}
			if step.Foreach != nil {
				if err := visit(step.Foreach.Body); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, definition := range definitions {
		if err := visit(workflowBody(definition)); err != nil {
			return err
		}
	}
	return nil
}
