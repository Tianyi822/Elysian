// register.go 提供能力子包共用的批量登记入口：登记与撤销都挂在装载它的 fiber 上。
package tools

import (
	"context"
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
)

// RegisterAll 在 c 上登记一批描述符。每条的撤销器登记为 effect，装载 c 所在
// fiber 销毁时自动回收；任一条登记失败即逆序撤销已登记的并返回合并错误
// （失败闭合，不留半张表）。
func RegisterAll(c *kardia.Context, descriptors ...Descriptor) error {
	if c == nil {
		return errors.New("登记工具必须提供 Context")
	}
	registry, err := RegistryFrom(c)
	if err != nil {
		return err
	}
	registered := make([]kardia.Disposable, 0, len(descriptors))
	for _, descriptor := range descriptors {
		dispose, err := registry.Register(descriptor)
		if err != nil {
			return joinRollback(registered, err)
		}
		label := fmt.Sprintf("tools.register(%q)", descriptor.Name)
		if _, err := c.Effect(label, func() (kardia.Disposable, error) { return dispose, nil }); err != nil {
			return joinRollback(registered, errors.Join(err, dispose(context.Background())))
		}
		registered = append(registered, dispose)
	}
	return nil
}

// joinRollback 逆序撤销已登记项，并与原始错误合并返回。撤销器幂等，fiber 后续
// 再跑一遍清理也安全。
func joinRollback(registered []kardia.Disposable, cause error) error {
	errs := []error{cause}
	for i := len(registered) - 1; i >= 0; i-- {
		if err := registered[i](context.Background()); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
