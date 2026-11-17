package harness

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/mcp"
)

func workflowDefinitionError(message string) error {
	return bad("workflow-definition-invalid", message)
}

var workflowBindingError = state.WorkflowBindingError

func validateWorkflowDefinition(d WorkflowDefinition) error {
	if d.LanguageVersion == WorkflowV2LanguageVersion {
		return validateWorkflowDefinitionV2(d)
	}
	if d.LanguageVersion != "" && d.LanguageVersion != "v1" && d.LanguageVersion != "workflow/v1" {
		return workflowDefinitionError("不支持的工作流 languageVersion")
	}
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 120 || !utf8.ValidString(d.Name) || strings.TrimSpace(d.Goal) == "" || len(d.Goal) > 32<<10 || !utf8.ValidString(d.Goal) || len(d.ID) > 128 || d.Revision < 0 {
		return workflowDefinitionError("工作流名称、目标或修订无效")
	}
	if len(d.Steps) < 1 || len(d.Steps) > state.WorkflowMaxSteps {
		return workflowDefinitionError("工作流必须包含 1 至 32 个步骤")
	}
	for _, schema := range []string{d.InputSchemaJSON, d.OutputSchemaJSON} {
		if mcp.ValidateSchema(json.RawMessage(schema)) != nil {
			return workflowDefinitionError("工作流输入或最终输出 JSON Schema 无效")
		}
	}
	steps := make(map[string]WorkflowStepDefinition, len(d.Steps))
	edges := make(map[string][]string, len(d.Steps))
	for _, step := range d.Steps {
		if step.Parallel != nil || step.Foreach != nil || step.Subworkflow != nil {
			return workflowDefinitionError("workflow/v1 不能包含复合步骤字段")
		}
		if !state.WorkflowStepID.MatchString(step.ID) {
			return workflowDefinitionError("步骤编号必须以字母开头且只含字母、数字、下划线或连字符，最长 64 字符")
		}
		if _, exists := steps[step.ID]; exists {
			return workflowDefinitionError("工作流步骤编号重复")
		}
		steps[step.ID] = step
		if mcp.ValidateSchema(json.RawMessage(step.OutputSchemaJSON)) != nil {
			return workflowDefinitionError("步骤输出 JSON Schema 无效")
		}
		if len(step.Instruction) > 32<<10 || !utf8.ValidString(step.Instruction) || len(step.Capability) > 128 {
			return workflowDefinitionError("步骤说明或能力名称超过限制")
		}
		if err := state.ValidateWorkflowBinding(step.Input, nil); err != nil {
			return err
		}
		if step.Kind == "condition" {
			if step.Condition == nil || step.Then == "" || step.Else == "" || step.Next != "" || step.Finish != nil || step.Capability != "" || step.Instruction != "" || step.Selection != nil {
				return workflowDefinitionError("条件步骤必须提供条件和两个分支，不能包含执行能力或直接结束")
			}
			if err := state.ValidateWorkflowCondition(*step.Condition, nil); err != nil {
				return err
			}
			if state.ValidateWorkflowJSON(step.OutputSchemaJSON, `{"matched":true}`) != nil || state.ValidateWorkflowJSON(step.OutputSchemaJSON, `{"matched":false}`) != nil {
				return workflowDefinitionError("条件步骤输出 Schema 必须接受 matched 布尔值")
			}
			edges[step.ID] = []string{step.Then, step.Else}
			continue
		}
		if step.Condition != nil || step.Then != "" || step.Else != "" || (step.Next == "") == (step.Finish == nil) {
			return workflowDefinitionError("执行或审批步骤必须在下一步与最终输出之间选择一项")
		}
		if step.Finish != nil {
			if err := state.ValidateWorkflowBinding(*step.Finish, nil); err != nil {
				return err
			}
		} else {
			edges[step.ID] = []string{step.Next}
		}
		switch step.Kind {
		case "agent":
			if strings.TrimSpace(step.Instruction) == "" || step.Capability != "" {
				return workflowDefinitionError("Agent 步骤必须提供说明且不能指定直接执行能力")
			}
			obj, err := jsonvalue.Object(json.RawMessage(step.OutputSchemaJSON))
			if err != nil || obj["type"] != "object" {
				return workflowDefinitionError("Agent 步骤输出 Schema 根类型必须是 object")
			}
			if step.Selection != nil && (step.Selection.RequestID != "" || step.Selection.Content != "" || len(step.Selection.Skills) > 32 || len(step.Selection.Resources) > 64 || len(step.Selection.Prompts) > 128) {
				return workflowDefinitionError("步骤资料选择只能包含有界的技能、资料和提示引用")
			}
		case "operation":
			if strings.TrimSpace(step.Capability) == "" || step.Selection != nil {
				return workflowDefinitionError("操作步骤必须提供能力别名且不能包含 Agent 资料选择")
			}
		case "approval":
			if strings.TrimSpace(step.Instruction) == "" || step.Capability != "" || step.Selection != nil || state.ValidateWorkflowJSON(step.OutputSchemaJSON, `{"approved":true}`) != nil {
				return workflowDefinitionError("审批步骤必须提供说明，并接受 approved=true 的固定输出")
			}
		default:
			return workflowDefinitionError("步骤类型只能是 agent、operation、approval 或 condition")
		}
	}
	if _, exists := steps[d.Entry]; !exists {
		return workflowDefinitionError("工作流入口步骤不存在")
	}
	predecessors := make(map[string][]string, len(steps))
	for from, next := range edges {
		for _, target := range next {
			if _, exists := steps[target]; !exists {
				return workflowDefinitionError("工作流引用了不存在的后续步骤")
			}
			predecessors[target] = append(predecessors[target], from)
		}
	}
	visited := map[string]int{}
	order := []string{}
	var visit func(string) error
	visit = func(id string) error {
		if visited[id] == 1 {
			return workflowDefinitionError("工作流包含循环，首版只允许有向无环步骤")
		}
		if visited[id] == 2 {
			return nil
		}
		visited[id] = 1
		for _, target := range edges[id] {
			if err := visit(target); err != nil {
				return err
			}
		}
		visited[id] = 2
		order = append(order, id)
		return nil
	}
	if err := visit(d.Entry); err != nil {
		return err
	}
	if len(order) != len(steps) {
		return workflowDefinitionError("工作流存在无法从入口到达的步骤")
	}
	dominators := map[string]map[string]bool{}
	for index := len(order) - 1; index >= 0; index-- {
		id := order[index]
		dom := map[string]bool{}
		for i, prev := range predecessors[id] {
			if i == 0 {
				for ancestor := range dominators[prev] {
					dom[ancestor] = true
				}
			} else {
				for ancestor := range dom {
					if !dominators[prev][ancestor] {
						delete(dom, ancestor)
					}
				}
			}
		}
		check := func(ref WorkflowOutputBinding) error {
			if !dom[ref.StepID] {
				return workflowDefinitionError("步骤输出引用必须由所有到达路径上的已完成前序步骤提供")
			}
			return nil
		}
		step := steps[id]
		if err := state.ValidateWorkflowBinding(step.Input, check); err != nil {
			return err
		}
		if step.Condition != nil {
			if err := state.ValidateWorkflowCondition(*step.Condition, check); err != nil {
				return err
			}
		}
		dom[id] = true
		if step.Finish != nil {
			if err := state.ValidateWorkflowBinding(*step.Finish, check); err != nil {
				return err
			}
		}
		dominators[id] = dom
	}
	raw, err := json.Marshal(d)
	if err != nil || len(raw) > 1<<20 {
		return workflowDefinitionError("工作流定义超过 1 MiB 上限或无法序列化")
	}
	return nil
}
