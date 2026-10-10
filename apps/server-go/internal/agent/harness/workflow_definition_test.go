package harness

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"elysian/server/internal/agent/jsonvalue"
)

func workflowTestLiteral(value string) WorkflowBinding { return WorkflowBinding{LiteralJSON: &value} }
func workflowTestInput(pointer string) WorkflowBinding { return WorkflowBinding{Input: &pointer} }
func workflowTestOutput(id, pointer string) WorkflowBinding {
	return WorkflowBinding{Step: &WorkflowOutputBinding{StepID: id, Pointer: pointer}}
}
func workflowTestCondition(op string, left, right WorkflowBinding) WorkflowCondition {
	return WorkflowCondition{Op: op, Left: &left, Right: &right}
}

func testWorkflowDefinition() WorkflowDefinition {
	finish := workflowTestOutput("review", "")
	return WorkflowDefinition{
		Name: "读取后确认", Goal: "检查状态并记录人工确认", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: `{"type":"object"}`, Entry: "read",
		Steps: []WorkflowStepDefinition{
			{ID: "read", Kind: "operation", Capability: "docker_containers_list", Input: workflowTestLiteral(`{}`), OutputSchemaJSON: `true`, Next: "review"},
			{ID: "review", Kind: "approval", Instruction: "确认检查结果", Input: workflowTestOutput("read", ""), OutputSchemaJSON: `{"type":"object","properties":{"approved":{"const":true}},"required":["approved"],"additionalProperties":false}`, Finish: &finish},
		},
	}
}

func TestWorkflowDefinitionGraphAndDominance(t *testing.T) {
	if err := validateWorkflowDefinition(testWorkflowDefinition()); err != nil {
		t.Fatal(err)
	}
	tooMany := testWorkflowDefinition()
	tooMany.Steps = make([]WorkflowStepDefinition, 33)
	if validateWorkflowDefinition(tooMany) == nil {
		t.Fatal("接受超过32步的模板")
	}
	tests := map[string]func(*WorkflowDefinition){
		"重复编号":       func(d *WorkflowDefinition) { d.Steps[1].ID = "read" },
		"缺失入口":       func(d *WorkflowDefinition) { d.Entry = "missing" },
		"缺失后继":       func(d *WorkflowDefinition) { d.Steps[0].Next = "missing" },
		"循环":         func(d *WorkflowDefinition) { d.Steps[1].Finish = nil; d.Steps[1].Next = "read" },
		"不可达":        func(d *WorkflowDefinition) { d.Entry = "review" },
		"同时后继与完成":    func(d *WorkflowDefinition) { d.Steps[1].Next = "read" },
		"非法自引用":      func(d *WorkflowDefinition) { d.Steps[0].Input = workflowTestOutput("read", "") },
		"非法未来引用":     func(d *WorkflowDefinition) { d.Steps[0].Input = workflowTestOutput("review", "") },
		"未知类型":       func(d *WorkflowDefinition) { d.Steps[0].Kind = "tool" },
		"审批输出冲突":     func(d *WorkflowDefinition) { d.Steps[1].OutputSchemaJSON = `{"const":{"approved":false}}` },
		"禁止外部Schema": func(d *WorkflowDefinition) { d.InputSchemaJSON = `{"$ref":"https://example.test/schema"}` },
		"Agent必须对象输出": func(d *WorkflowDefinition) {
			d.Steps[0].Kind = "agent"
			d.Steps[0].Capability = ""
			d.Steps[0].Instruction = "分析"
			d.Steps[0].OutputSchemaJSON = `true`
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			d := testWorkflowDefinition()
			mutate(&d)
			if validateWorkflowDefinition(d) == nil {
				t.Fatal("接受了无效模板")
			}
		})
	}
	finish := workflowTestOutput("gate", "/matched")
	condition := workflowTestCondition("eq", workflowTestInput("/enabled"), workflowTestLiteral(`true`))
	d := WorkflowDefinition{Name: "分支汇合", Goal: "只使用每条路径都有的结果", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: `{"type":"boolean"}`, Entry: "gate", Steps: []WorkflowStepDefinition{
		{ID: "gate", Kind: "condition", Input: workflowTestLiteral(`{}`), OutputSchemaJSON: `{"type":"object"}`, Condition: &condition, Then: "left", Else: "right"},
		{ID: "left", Kind: "operation", Capability: "inspect", Input: workflowTestLiteral(`{}`), OutputSchemaJSON: `true`, Next: "join"},
		{ID: "right", Kind: "operation", Capability: "inspect", Input: workflowTestLiteral(`{}`), OutputSchemaJSON: `true`, Next: "join"},
		{ID: "join", Kind: "approval", Instruction: "确认", Input: workflowTestOutput("gate", ""), OutputSchemaJSON: `{"type":"object"}`, Finish: &finish},
	}}
	if err := validateWorkflowDefinition(d); err != nil {
		t.Fatal(err)
	}
	d.Steps[3].Input = workflowTestOutput("left", "")
	if validateWorkflowDefinition(d) == nil {
		t.Fatal("接受了只在某条分支存在的输出")
	}
	d.Steps[3].Input = workflowTestOutput("gate", "")
	d.Steps[0].OutputSchemaJSON = `{"const":{"matched":true}}`
	if validateWorkflowDefinition(d) == nil {
		t.Fatal("条件输出Schema排除了false分支")
	}
}

func TestWorkflowBindingExactJSONAndPointers(t *testing.T) {
	input := `{"a/b":{"~key":[9007199254740993,null]},"01":"object-key"}`
	binding := WorkflowBinding{Object: map[string]WorkflowBinding{
		"large": workflowTestInput("/a~1b/~0key/0"), "nothing": workflowTestInput("/a~1b/~0key/1"),
		"result": workflowTestOutput("read", "/value"), "emptyObject": {Object: map[string]WorkflowBinding{}},
		"array":      {Array: []WorkflowBinding{workflowTestLiteral(`1e50`), workflowTestInput("/01")}},
		"emptyArray": {Array: []WorkflowBinding{}},
	}}
	got, err := evaluateWorkflowBinding(binding, input, map[string]string{"read": `{"value":9007199254740995}`})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"array":[1e50,"object-key"],"emptyArray":[],"emptyObject":{},"large":9007199254740993,"nothing":null,"result":9007199254740995}`
	if got != want {
		t.Fatalf("绑定精度或结构错误：%s", got)
	}
	for _, b := range []WorkflowBinding{{Object: map[string]WorkflowBinding{}}, {Array: []WorkflowBinding{}}} {
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatal(err)
		}
		var roundtrip WorkflowBinding
		if err = json.Unmarshal(raw, &roundtrip); err != nil {
			t.Fatal(err)
		}
		if validateWorkflowBinding(roundtrip, nil) != nil {
			t.Fatalf("空容器绑定在存储往返中丢失：%s", raw)
		}
	}
	for _, raw := range []string{`{"input":null}`, `{"object":null}`, `{"array":null}`, `{"input":"","literalJson":null}`, `{"input":"","input":"/x"}`, `{"unknown":{}}`} {
		var binding WorkflowBinding
		if json.Unmarshal([]byte(raw), &binding) == nil {
			t.Fatalf("接受含歧义或未知字段的绑定：%s", raw)
		}
	}
	largeInput := `"` + strings.Repeat("a", workflowMaxJSONBytes/2) + `"`
	amplified := WorkflowBinding{Array: []WorkflowBinding{workflowTestInput(""), workflowTestInput(""), workflowTestInput("")}}
	if _, err := evaluateWorkflowBinding(amplified, largeInput, nil); err == nil {
		t.Fatal("重复引用绕过求值输出限额")
	}
	for name, b := range map[string]WorkflowBinding{
		"重复选择": {Input: workflowTestInput("").Input, LiteralJSON: workflowTestLiteral(`{}`).LiteralJSON},
		"缺少选择": {}, "重复JSON字段": workflowTestLiteral(`{"x":1,"x":2}`), "无效转义": workflowTestInput("/a~2b"),
		"非Pointer": workflowTestInput("x"), "越界数组": workflowTestInput("/a~1b/~0key/2"), "数组前导零": workflowTestInput("/a~1b/~0key/01"),
		"缺失结果": workflowTestOutput("missing", ""),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := evaluateWorkflowBinding(b, input, nil); err == nil {
				t.Fatal("接受无效绑定")
			}
		})
	}
	deep := workflowTestLiteral(`null`)
	for i := 0; i < workflowMaxDepth+1; i++ {
		deep = WorkflowBinding{Array: []WorkflowBinding{deep}}
	}
	if _, err := evaluateWorkflowBinding(deep, `{}`, nil); err == nil {
		t.Fatal("接受过深绑定")
	}
}

func TestWorkflowConditionsExactNumbersAndFiniteOperations(t *testing.T) {
	tests := []struct {
		op, left, right string
		want            bool
	}{
		{"gt", `9007199254740993`, `9007199254740992`, true}, {"eq", `9007199254740993`, `9007199254740992`, false},
		{"eq", `1.000`, `1e0`, true}, {"eq", `-0`, `0.0`, true}, {"lt", `-1.01`, `-1`, true},
		{"gte", `1e999999999`, `10e999999998`, true}, {"lt", `9e999999998`, `1e999999999`, true},
		{"eq", `{"a":[1.0,null,true]}`, `{"a":[1,null,true]}`, true}, {"ne", `"1"`, `1`, true},
	}
	for _, test := range tests {
		got, err := evaluateWorkflowCondition(workflowTestCondition(test.op, workflowTestLiteral(test.left), workflowTestLiteral(test.right)), `{}`, nil)
		if err != nil || got != test.want {
			t.Fatalf("%s %s %s：%v %v", test.left, test.op, test.right, got, err)
		}
	}
	left := workflowTestInput("/absent")
	exists := WorkflowCondition{Op: "exists", Left: &left}
	if got, err := evaluateWorkflowCondition(exists, `{}`, nil); err != nil || got {
		t.Fatalf("不存在字段：%v %v", got, err)
	}
	left = workflowTestInput("/value")
	if got, err := evaluateWorkflowCondition(exists, `{"value":null}`, nil); err != nil || !got {
		t.Fatalf("null仍是存在字段：%v %v", got, err)
	}
	left = workflowTestOutput("absent", "")
	if _, err := evaluateWorkflowCondition(exists, `{}`, nil); err == nil {
		t.Fatal("exists吞掉了缺失步骤结果")
	}
	falseCondition := workflowTestCondition("eq", workflowTestLiteral(`1`), workflowTestLiteral(`2`))
	missingComparison := workflowTestCondition("eq", workflowTestInput("/absent"), workflowTestLiteral(`null`))
	if got, err := evaluateWorkflowCondition(WorkflowCondition{Op: "and", Children: []WorkflowCondition{falseCondition, missingComparison}}, `{}`, nil); err != nil || got {
		t.Fatalf("and未短路：%v %v", got, err)
	}
	for _, condition := range []WorkflowCondition{
		{Op: "eval", Left: &left}, {Op: "not"}, {Op: "or"}, workflowTestCondition("gt", workflowTestLiteral(`"2"`), workflowTestLiteral(`1`)),
		{Op: "and", Children: []WorkflowCondition{falseCondition, {Op: "eval"}}},
	} {
		if _, err := evaluateWorkflowCondition(condition, `{}`, nil); err == nil {
			t.Fatalf("接受无效条件：%+v", condition)
		}
	}
}

func TestWorkflowJSONSchemaStrict2020AndPrecision(t *testing.T) {
	schema := `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"value":{"type":"integer","minimum":9007199254740993}},"required":["value"],"unevaluatedProperties":false}`
	if err := validateWorkflowJSON(schema, `{"value":9007199254740993}`); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`{"value":9007199254740992}`, `{"value":9007199254740993,"extra":true}`, `{"value":1,"value":9007199254740993}`} {
		if validateWorkflowJSON(schema, value) == nil {
			t.Fatalf("接受不合约束的值：%s", value)
		}
	}
	for _, invalid := range []string{`{"unknownConstraint":true}`, `{"$ref":"https://example.test/schema"}`, `{"$schema":"http://json-schema.org/draft-07/schema#"}`} {
		if validateWorkflowJSON(invalid, `{}`) == nil {
			t.Fatalf("接受不支持的schema：%s", invalid)
		}
	}
	if validateWorkflowJSON(`true`, `"`+strings.Repeat("a", workflowMaxJSONBytes)+`"`) == nil {
		t.Fatal("接受超限JSON")
	}
}

func TestWorkflowSharedFixtureRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("../../../../../packages/foundation/contracts/fixtures/agent-workflow.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Definition         WorkflowDefinition    `json:"definition"`
		InputJSON          string                `json:"inputJson"`
		ExpectedOutputJSON string                `json:"expectedOutputJson"`
		Instance           WorkflowInstance      `json:"instance"`
		Attempt            WorkflowAttempt       `json:"attempt"`
		Event              WorkflowEvent         `json:"event"`
		Create             CreateWorkflowInput   `json:"create"`
		Recovery           WorkflowRecoveryInput `json:"recovery"`
		Run                Run                   `json:"run"`
		Operation          Operation             `json:"operation"`
		Approval           Approval              `json:"approval"`
		Barrier            ExecutionBarrier      `json:"barrier"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	if err = validateWorkflowDefinition(fixture.Definition); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	want, err := jsonvalue.Canonical(raw)
	if err != nil {
		t.Fatal(err)
	}
	got, err := jsonvalue.Canonical(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, got) {
		t.Fatalf("工作流契约往返不一致：\n%s\n%s", want, got)
	}
	if validateWorkflowJSON(fixture.Definition.InputSchemaJSON, fixture.InputJSON) != nil || validateWorkflowJSON(fixture.Definition.OutputSchemaJSON, fixture.ExpectedOutputJSON) != nil {
		t.Fatal("共享输入或输出不符合schema")
	}
	if fixture.Approval.Kind != "workflow-gate" || fixture.Run.WorkflowFrozenFrom != StateWaitingApproval || fixture.Instance.LastSeq != "9007199254740993" || fixture.Attempt.EventSeq != fixture.Instance.LastSeq {
		t.Fatal("恢复状态、工作流审批或事件精度不符合契约")
	}
}
