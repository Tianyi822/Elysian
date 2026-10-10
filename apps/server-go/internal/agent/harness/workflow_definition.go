package harness

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/mcp"
)

const (
	workflowMaxSteps        = 32
	workflowMaxJSONBytes    = 256 << 10
	workflowMaxDepth        = 32
	workflowMaxBindingNodes = 4096
)

var workflowStepID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
var errWorkflowPointerMissing = errors.New("工作流 JSON Pointer 指向的值不存在")

func workflowDefinitionError(message string) error {
	return bad("workflow-definition-invalid", message)
}
func workflowBindingError(message string) error { return bad("workflow-binding-invalid", message) }

func validateWorkflowJSON(schemaJSON, valueJSON string) error {
	if mcp.ValidateSchema(json.RawMessage(schemaJSON)) != nil {
		return bad("workflow-schema-invalid", "工作流 JSON Schema 无效或包含不支持的约束")
	}
	if len(valueJSON) > workflowMaxJSONBytes {
		return bad("workflow-json-limit", "工作流 JSON 值超过 256 KiB 上限")
	}
	if _, err := jsonvalue.Decode(json.RawMessage(valueJSON)); err != nil {
		return bad("workflow-json-invalid", "工作流 JSON 值无效或包含重复字段")
	}
	if mcp.Validate(json.RawMessage(schemaJSON), json.RawMessage(valueJSON)) != nil {
		return bad("workflow-schema-mismatch", "工作流输入或输出不符合固定的 JSON Schema")
	}
	return nil
}

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
	if len(d.Steps) < 1 || len(d.Steps) > workflowMaxSteps {
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
		if !workflowStepID.MatchString(step.ID) {
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
		if err := validateWorkflowBinding(step.Input, nil); err != nil {
			return err
		}
		if step.Kind == "condition" {
			if step.Condition == nil || step.Then == "" || step.Else == "" || step.Next != "" || step.Finish != nil || step.Capability != "" || step.Instruction != "" || step.Selection != nil {
				return workflowDefinitionError("条件步骤必须提供条件和两个分支，不能包含执行能力或直接结束")
			}
			if err := validateWorkflowCondition(*step.Condition, nil); err != nil {
				return err
			}
			if validateWorkflowJSON(step.OutputSchemaJSON, `{"matched":true}`) != nil || validateWorkflowJSON(step.OutputSchemaJSON, `{"matched":false}`) != nil {
				return workflowDefinitionError("条件步骤输出 Schema 必须接受 matched 布尔值")
			}
			edges[step.ID] = []string{step.Then, step.Else}
			continue
		}
		if step.Condition != nil || step.Then != "" || step.Else != "" || (step.Next == "") == (step.Finish == nil) {
			return workflowDefinitionError("执行或审批步骤必须在下一步与最终输出之间选择一项")
		}
		if step.Finish != nil {
			if err := validateWorkflowBinding(*step.Finish, nil); err != nil {
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
			if strings.TrimSpace(step.Instruction) == "" || step.Capability != "" || step.Selection != nil || validateWorkflowJSON(step.OutputSchemaJSON, `{"approved":true}`) != nil {
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
	state := map[string]int{}
	order := []string{}
	var visit func(string) error
	visit = func(id string) error {
		if state[id] == 1 {
			return workflowDefinitionError("工作流包含循环，首版只允许有向无环步骤")
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		for _, target := range edges[id] {
			if err := visit(target); err != nil {
				return err
			}
		}
		state[id] = 2
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
		if err := validateWorkflowBinding(step.Input, check); err != nil {
			return err
		}
		if step.Condition != nil {
			if err := validateWorkflowCondition(*step.Condition, check); err != nil {
				return err
			}
		}
		dom[id] = true
		if step.Finish != nil {
			if err := validateWorkflowBinding(*step.Finish, check); err != nil {
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

func workflowPointerTokens(pointer string) ([]string, error) {
	if len(pointer) > 4096 || !utf8.ValidString(pointer) {
		return nil, workflowBindingError("JSON Pointer 超过限制或编码无效")
	}
	if pointer == "" {
		return nil, nil
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, workflowBindingError("JSON Pointer 必须为空或以斜杠开头")
	}
	parts := strings.Split(pointer[1:], "/")
	for i, part := range parts {
		var token strings.Builder
		for j := 0; j < len(part); j++ {
			if part[j] != '~' {
				token.WriteByte(part[j])
				continue
			}
			j++
			if j >= len(part) || (part[j] != '0' && part[j] != '1') {
				return nil, workflowBindingError("JSON Pointer 包含无效转义")
			}
			if part[j] == '0' {
				token.WriteByte('~')
			} else {
				token.WriteByte('/')
			}
		}
		parts[i] = token.String()
	}
	return parts, nil
}

func validateWorkflowBinding(binding WorkflowBinding, ref func(WorkflowOutputBinding) error) error {
	count := 0
	return walkWorkflowBinding(binding, 0, &count, ref)
}

func walkWorkflowBinding(binding WorkflowBinding, depth int, count *int, ref func(WorkflowOutputBinding) error) error {
	*count++
	if depth > workflowMaxDepth || *count > workflowMaxBindingNodes {
		return workflowBindingError("工作流绑定嵌套或条目数量超过限制")
	}
	choices := 0
	if binding.LiteralJSON != nil {
		choices++
		if len(*binding.LiteralJSON) > workflowMaxJSONBytes {
			return workflowBindingError("绑定字面量超过 256 KiB 上限")
		}
		if _, err := jsonvalue.Decode(json.RawMessage(*binding.LiteralJSON)); err != nil {
			return workflowBindingError("绑定字面量不是严格 JSON")
		}
	}
	if binding.Input != nil {
		choices++
		if _, err := workflowPointerTokens(*binding.Input); err != nil {
			return err
		}
	}
	if binding.Step != nil {
		choices++
		if !workflowStepID.MatchString(binding.Step.StepID) {
			return workflowBindingError("绑定的步骤编号无效")
		}
		if _, err := workflowPointerTokens(binding.Step.Pointer); err != nil {
			return err
		}
		if ref != nil {
			if err := ref(*binding.Step); err != nil {
				return err
			}
		}
	}
	if binding.Object != nil {
		choices++
		for key, child := range binding.Object {
			if len(key) > 4096 || !utf8.ValidString(key) {
				return workflowBindingError("绑定对象字段名无效")
			}
			if err := walkWorkflowBinding(child, depth+1, count, ref); err != nil {
				return err
			}
		}
	}
	if binding.Array != nil {
		choices++
		for _, child := range binding.Array {
			if err := walkWorkflowBinding(child, depth+1, count, ref); err != nil {
				return err
			}
		}
	}
	if choices != 1 {
		return workflowBindingError("工作流绑定必须且只能选择字面量、输入、步骤输出、对象或数组之一")
	}
	return nil
}

func validateWorkflowCondition(condition WorkflowCondition, ref func(WorkflowOutputBinding) error) error {
	count, bindingCount := 0, 0
	var walk func(WorkflowCondition, int) error
	walk = func(c WorkflowCondition, depth int) error {
		count++
		if depth > workflowMaxDepth || count > 1024 {
			return workflowBindingError("工作流条件嵌套或条目数量超过限制")
		}
		switch c.Op {
		case "eq", "ne", "lt", "lte", "gt", "gte":
			if c.Left == nil || c.Right == nil || len(c.Children) != 0 {
				return workflowBindingError("比较条件必须恰好包含左右两个绑定")
			}
		case "exists":
			if c.Left == nil || c.Right != nil || len(c.Children) != 0 {
				return workflowBindingError("存在性条件必须恰好包含一个左侧绑定")
			}
		case "and", "or":
			if c.Left != nil || c.Right != nil || len(c.Children) < 1 {
				return workflowBindingError("逻辑条件必须只包含一个或多个子条件")
			}
		case "not":
			if c.Left != nil || c.Right != nil || len(c.Children) != 1 {
				return workflowBindingError("取反条件必须恰好包含一个子条件")
			}
		default:
			return workflowBindingError("工作流条件运算符不受支持")
		}
		for _, b := range []*WorkflowBinding{c.Left, c.Right} {
			if b != nil {
				if err := walkWorkflowBinding(*b, 0, &bindingCount, ref); err != nil {
					return err
				}
			}
		}
		for _, child := range c.Children {
			if err := walk(child, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(condition, 0)
}

type workflowBindingEvaluator struct {
	input     any
	outputs   map[string]string
	parsed    map[string]any
	remaining int
}

func newWorkflowEvaluator(input string, outputs map[string]string) (*workflowBindingEvaluator, error) {
	if len(input) > workflowMaxJSONBytes {
		return nil, workflowBindingError("工作流输入超过 256 KiB 上限")
	}
	value, err := jsonvalue.Decode(json.RawMessage(input))
	if err != nil {
		return nil, workflowBindingError("工作流输入不是严格 JSON")
	}
	return &workflowBindingEvaluator{input: value, outputs: outputs, parsed: map[string]any{}, remaining: workflowMaxJSONBytes}, nil
}

func (e *workflowBindingEvaluator) reserve(bytes int) error {
	e.remaining -= bytes
	if e.remaining < 0 {
		return workflowBindingError("求值后的工作流 JSON 超过 256 KiB 上限")
	}
	return nil
}

func (e *workflowBindingEvaluator) leaf(value any, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, workflowBindingError("工作流绑定结果无法序列化")
	}
	if err = e.reserve(len(raw)); err != nil {
		return nil, err
	}
	return value, nil
}

func workflowSelect(value any, pointer string) (any, error) {
	tokens, err := workflowPointerTokens(pointer)
	if err != nil {
		return nil, err
	}
	for _, token := range tokens {
		switch object := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = object[token]
			if !ok {
				return nil, errWorkflowPointerMissing
			}
		case []any:
			if token == "" || (len(token) > 1 && token[0] == '0') {
				return nil, errWorkflowPointerMissing
			}
			for _, c := range token {
				if c < '0' || c > '9' {
					return nil, errWorkflowPointerMissing
				}
			}
			index, err := strconv.ParseUint(token, 10, 31)
			if err != nil || index >= uint64(len(object)) {
				return nil, errWorkflowPointerMissing
			}
			value = object[index]
		default:
			return nil, errWorkflowPointerMissing
		}
	}
	return value, nil
}

func (e *workflowBindingEvaluator) binding(b WorkflowBinding) (any, error) {
	switch {
	case b.LiteralJSON != nil:
		return e.leaf(jsonvalue.Decode(json.RawMessage(*b.LiteralJSON)))
	case b.Input != nil:
		return e.leaf(workflowSelect(e.input, *b.Input))
	case b.Step != nil:
		value, ok := e.parsed[b.Step.StepID]
		if !ok {
			raw, exists := e.outputs[b.Step.StepID]
			if !exists {
				return nil, workflowBindingError("所引用的步骤尚无已确认输出")
			}
			if len(raw) > workflowMaxJSONBytes {
				return nil, workflowBindingError("步骤输出超过 256 KiB 上限")
			}
			var err error
			value, err = jsonvalue.Decode(json.RawMessage(raw))
			if err != nil {
				return nil, workflowBindingError("已确认的步骤输出不是严格 JSON")
			}
			e.parsed[b.Step.StepID] = value
		}
		return e.leaf(workflowSelect(value, b.Step.Pointer))
	case b.Object != nil:
		if err := e.reserve(2); err != nil {
			return nil, err
		}
		value := map[string]any{}
		for name, child := range b.Object {
			key, _ := json.Marshal(name)
			separator := 1
			if len(value) > 0 {
				separator++
			}
			if err := e.reserve(len(key) + separator); err != nil {
				return nil, err
			}
			v, err := e.binding(child)
			if err != nil {
				return nil, err
			}
			value[name] = v
		}
		return value, nil
	case b.Array != nil:
		overhead := 2
		if len(b.Array) > 0 {
			overhead += len(b.Array) - 1
		}
		if err := e.reserve(overhead); err != nil {
			return nil, err
		}
		value := make([]any, len(b.Array))
		for i, child := range b.Array {
			v, err := e.binding(child)
			if err != nil {
				return nil, err
			}
			value[i] = v
		}
		return value, nil
	}
	return nil, workflowBindingError("工作流绑定没有选择值来源")
}

func evaluateWorkflowBinding(binding WorkflowBinding, input string, outputs map[string]string) (string, error) {
	if err := validateWorkflowBinding(binding, nil); err != nil {
		return "", err
	}
	e, err := newWorkflowEvaluator(input, outputs)
	if err != nil {
		return "", err
	}
	value, err := e.binding(binding)
	if errors.Is(err, errWorkflowPointerMissing) {
		return "", workflowBindingError(err.Error())
	}
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > workflowMaxJSONBytes {
		return "", workflowBindingError("求值后的工作流 JSON 超过 256 KiB 上限或无效")
	}
	return string(raw), nil
}

// decimalOrder 不展开指数；即使 1e100000000 也只保存数字串与数量级。
func workflowDecimal(n json.Number) (sign int, digits string, order *big.Int) {
	text := string(n)
	sign = 1
	if strings.HasPrefix(text, "-") {
		sign = -1
		text = text[1:]
	}
	exponent := new(big.Int)
	if index := strings.IndexAny(text, "eE"); index >= 0 {
		exponent.SetString(text[index+1:], 10)
		text = text[:index]
	}
	fraction := 0
	if index := strings.IndexByte(text, '.'); index >= 0 {
		fraction = len(text) - index - 1
		text = text[:index] + text[index+1:]
	}
	digits = strings.TrimLeft(text, "0")
	if digits == "" {
		return 0, "", new(big.Int)
	}
	order = exponent.Add(exponent, big.NewInt(int64(len(digits)-fraction)))
	return sign, strings.TrimRight(digits, "0"), order
}

func compareWorkflowNumbers(left, right json.Number) int {
	ls, ld, lo := workflowDecimal(left)
	rs, rd, ro := workflowDecimal(right)
	if ls < rs {
		return -1
	}
	if ls > rs {
		return 1
	}
	if ls == 0 {
		return 0
	}
	if cmp := lo.Cmp(ro); cmp != 0 {
		return ls * cmp
	}
	length := len(ld)
	if len(rd) > length {
		length = len(rd)
	}
	for i := 0; i < length; i++ {
		a, b := byte('0'), byte('0')
		if i < len(ld) {
			a = ld[i]
		}
		if i < len(rd) {
			b = rd[i]
		}
		if a < b {
			return -ls
		}
		if a > b {
			return ls
		}
	}
	return 0
}

func equalWorkflowValues(left, right any) bool {
	switch l := left.(type) {
	case nil:
		return right == nil
	case bool:
		r, ok := right.(bool)
		return ok && l == r
	case string:
		r, ok := right.(string)
		return ok && l == r
	case json.Number:
		r, ok := right.(json.Number)
		return ok && compareWorkflowNumbers(l, r) == 0
	case []any:
		r, ok := right.([]any)
		if !ok || len(l) != len(r) {
			return false
		}
		for i := range l {
			if !equalWorkflowValues(l[i], r[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		r, ok := right.(map[string]any)
		if !ok || len(l) != len(r) {
			return false
		}
		for k, v := range l {
			other, exists := r[k]
			if !exists || !equalWorkflowValues(v, other) {
				return false
			}
		}
		return true
	}
	return false
}

func (e *workflowBindingEvaluator) condition(c WorkflowCondition) (bool, error) {
	if c.Op == "and" || c.Op == "or" || c.Op == "not" {
		for _, child := range c.Children {
			value, err := e.condition(child)
			if err != nil {
				return false, err
			}
			if c.Op == "not" {
				return !value, nil
			}
			if c.Op == "and" && !value {
				return false, nil
			}
			if c.Op == "or" && value {
				return true, nil
			}
		}
		return c.Op == "and", nil
	}
	// 每个条件操作数独立受输出大小限制；逻辑树本身已有总节点上限。
	e.remaining = workflowMaxJSONBytes
	left, err := e.binding(*c.Left)
	if c.Op == "exists" && errors.Is(err, errWorkflowPointerMissing) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if c.Op == "exists" {
		return true, nil
	}
	e.remaining = workflowMaxJSONBytes
	right, err := e.binding(*c.Right)
	if err != nil {
		return false, err
	}
	if c.Op == "eq" {
		return equalWorkflowValues(left, right), nil
	}
	if c.Op == "ne" {
		return !equalWorkflowValues(left, right), nil
	}
	l, lok := left.(json.Number)
	r, rok := right.(json.Number)
	if !lok || !rok {
		return false, workflowBindingError("顺序比较仅适用于 JSON 数值，不自动转换类型")
	}
	cmp := compareWorkflowNumbers(l, r)
	switch c.Op {
	case "lt":
		return cmp < 0, nil
	case "lte":
		return cmp <= 0, nil
	case "gt":
		return cmp > 0, nil
	case "gte":
		return cmp >= 0, nil
	}
	return false, workflowBindingError("工作流条件运算符不受支持")
}

func evaluateWorkflowCondition(condition WorkflowCondition, input string, outputs map[string]string) (bool, error) {
	if err := validateWorkflowCondition(condition, nil); err != nil {
		return false, err
	}
	e, err := newWorkflowEvaluator(input, outputs)
	if err != nil {
		return false, err
	}
	value, err := e.condition(condition)
	if errors.Is(err, errWorkflowPointerMissing) {
		return false, workflowBindingError(err.Error())
	}
	return value, err
}
