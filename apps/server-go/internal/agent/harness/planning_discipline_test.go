package harness

import (
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
)

// 规划纪律：简单任务直接执行，只有 3 个及以上可独立检查的步骤才建计划；
// 创建资源前先核对现有资源与容量。
func TestContextPlanningDiscipline(t *testing.T) {
	snapshot := CapabilitySnapshot{ToolLoading: onDemandTools, Tools: []Capability{
		toolSearchCapability(), planCapability(), userInputCapability(),
		{Name: "docker_containers_list", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "docker"}},
	}}
	a := &agentExecution{run: Run{DriverVersion: "v2", Snapshot: &snapshot, Task: &Task{}}}
	system := baseContext(a, WorkingMemory{}, agentSystem, nil)[0].Content
	for _, want := range []string{"先判断任务规模", "3 个及以上可独立检查的步骤", "创建容器、实例等资源前，先用只读工具核对现有资源和宿主容量"} {
		if !strings.Contains(system, want) {
			t.Errorf("系统提示词缺少规划纪律 %q：%s", want, system)
		}
	}
	if strings.Contains(system, "简单问答无需计划") {
		t.Error("系统提示词仍按「简单问答」划界，简单操作任务会被当成复杂任务拆分")
	}
	description := planCapability().Description
	if !strings.Contains(description, "3 个及以上可独立检查的步骤") || strings.Contains(description, "简单问答无需计划") {
		t.Errorf("update_plan 描述未说明何时才需要计划：%s", description)
	}
}

// 「创建前先核对」与计划能力无关：没有 update_plan 的运行也要保留这条规则。
func TestContextResourceCheckRuleDoesNotDependOnPlanCapability(t *testing.T) {
	snapshot := CapabilitySnapshot{ToolLoading: onDemandTools, Tools: []Capability{toolSearchCapability()}}
	a := &agentExecution{run: Run{DriverVersion: "v2", Snapshot: &snapshot, Task: &Task{}}}
	system := baseContext(a, WorkingMemory{}, agentSystem, nil)[0].Content
	if strings.Contains(system, "先判断任务规模") {
		t.Error("没有计划能力时仍注入了规划说明")
	}
	if !strings.Contains(system, "创建容器、实例等资源前，先用只读工具核对现有资源和宿主容量") {
		t.Errorf("系统提示词缺少创建前核对规则：%s", system)
	}
}
