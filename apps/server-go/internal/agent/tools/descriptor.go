// descriptor.go 定义工具描述符与调用/结果的数据形状。描述符只承载「叫什么、
// 收什么参数、怎么执行」，不承载风险等级与审批要求：那属于外部策略
// （AGENTS.md 把「哪些动作必须人为干预」推迟给 harness 层）。
package tools

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"elysian/server/internal/agent/kardia"
)

// Arguments 是一次调用的参数表，形态与 JSON 对象解码结果一致。
type Arguments = map[string]any

// Handler 执行工具本体。首参是调用点 Context（use site），阻塞实现应响应
// 它的 Lifetime。返回值必须是可无损序列化的 JSON 值。
type Handler func(c *kardia.Context, args Arguments) (any, error)

// Deny 是 pre-execute 监听者的拒绝裁决。返回非 nil 即中断执行，处理器不会被
// 调用（deny-only：本层的监听者只能拒，不能代替处理器产出结果）。
type Deny struct {
	Reason string
}

// DeniedError 表示调用被策略拒绝，与执行失败区分开，便于上层审计。
type DeniedError struct {
	Name   string
	Reason string
}

// Error 返回中文拒绝文案。
func (e *DeniedError) Error() string {
	return fmt.Sprintf("工具 %q 被拒绝执行：%s", e.Name, e.Reason)
}

// Call 是一次调用的不可变描述，作为三段瀑布与 result 事件的参数。
type Call struct {
	ID   string
	Name string
	Args Arguments
}

// Outcome 是一次调用的结果。post-execute 监听者可以整体替换它（降级、改写、
// 把失败转成可读结果）。
type Outcome struct {
	Value any
	Err   error
}

// ChangeKind 描述注册表成员的变化。
type ChangeKind string

const (
	// ChangeRegistered 是登记。
	ChangeRegistered ChangeKind = "registered"
	// ChangeRemoved 是撤销。
	ChangeRemoved ChangeKind = "removed"
)

// Change 是 tools/change 事件的参数。
type Change struct {
	Kind ChangeKind
	Name string
}

// PublicSchema 是对外可见的描述符投影：只含名字、说明与参数模式，处理器与
// 内部字段不外泄。
type PublicSchema struct {
	Name        string
	Description string
	Parameters  map[string]any
}

// Descriptor 声明一条工具。
type Descriptor struct {
	// Name 是唯一标识，只允许小写字母、数字与下划线，最长 64 字符。
	Name string
	// Description 是给调用方看的中文说明，不得为空。
	Description string
	// Parameters 是参数模式；无参数的工具写 Schema{Type: SchemaObject}。
	Parameters Schema
	// Handler 是执行体，不得为空。
	Handler Handler
}

// descriptorNamePattern 限定工具名形状，避免把命名冲突带进事件名与日志。
var descriptorNamePattern = regexp.MustCompile(`^[a-z0-9_]+$`)

// validate 在登记前校验描述符，任何一项不合法即拒绝（失败闭合）。
func (d Descriptor) validate() error {
	if d.Name == "" {
		return errors.New("工具名字不得为空")
	}
	if len(d.Name) > 64 {
		return fmt.Errorf("工具名字 %q 超过 64 个字符", d.Name)
	}
	if !descriptorNamePattern.MatchString(d.Name) {
		return fmt.Errorf("工具名字 %q 只能由小写字母、数字与下划线组成", d.Name)
	}
	if strings.TrimSpace(d.Description) == "" {
		return fmt.Errorf("工具 %q 的说明不得为空", d.Name)
	}
	if d.Handler == nil {
		return fmt.Errorf("工具 %q 的处理器不得为空", d.Name)
	}
	if err := d.Parameters.checkShape(d.Name); err != nil {
		return fmt.Errorf("工具 %q 的参数模式非法：%w", d.Name, err)
	}
	return nil
}

// Public 返回对外投影。
func (d Descriptor) Public() PublicSchema {
	return PublicSchema{
		Name:        d.Name,
		Description: d.Description,
		Parameters:  d.Parameters.JSONSchema(),
	}
}
