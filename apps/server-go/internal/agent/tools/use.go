// use.go 补上 kardia 缺失的泛型取值：Context.Get 返回 any，注入名与提供名
// 之间也没有编译期关联（ADR-0023 缺口 2）。
package tools

import (
	"context"
	"fmt"

	"elysian/server/internal/agent/kardia"
)

// Lifetime 取调用点的协作取消信号：能力服务把域调用挂在调用方 fiber 的生命周期
// 上，fiber 销毁即中止在途请求。access 为 nil 时退回 context.Background()。
func Lifetime(access *kardia.Context) context.Context {
	if access == nil {
		return context.Background()
	}
	return access.Lifetime()
}

// Use 按服务名取值并断言类型。未提供、类型不符都返回中文错误（失败闭合），
// 不返回零值加 nil。
func Use[T any](c *kardia.Context, name string) (T, error) {
	var zero T
	if c == nil {
		return zero, fmt.Errorf("取服务 %q 必须提供 Context", name)
	}
	value, err := c.Get(name)
	if err != nil {
		return zero, err
	}
	if value == nil {
		return zero, fmt.Errorf("服务 %q 未提供", name)
	}
	got, ok := value.(T)
	if !ok {
		return zero, fmt.Errorf("服务 %q 的类型不符：期望 %T，实际 %T", name, zero, value)
	}
	return got, nil
}

// RegistryFrom 取注册表服务。能力插件的 Apply 里用它拿到注入就绪的注册表。
func RegistryFrom(c *kardia.Context) (*Registry, error) {
	return Use[*Registry](c, ServiceName)
}
