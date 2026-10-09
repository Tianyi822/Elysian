// install.go 提供宿主的装载入口。kardia 的 RegistryService.Plugin 不把 Apply
// 的错误穿透给调用方（错误只落在 fiber 上，见 kardia/registry.go:157-158），
// 因此装载必须紧跟 Await，否则「装载成功」是假象（ADR-0023 缺口 4）。
package tools

import (
	"context"
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
)

// Install 按顺序装载插件并等待每条 fiber 收敛。任一条失败即逆序销毁已装载的
// fiber 并返回合并错误；成功时返回全部 fiber，由宿主持有并在退出时销毁。
// ctx 用于取消等待。插件须按依赖顺序传入；Await 只保证状态收敛，缺少注入
// 仍可能停在 pending，因此还必须检查激活态。
func Install(ctx context.Context, c *kardia.Context, plugins ...*kardia.Plugin) ([]*kardia.Fiber, error) {
	if ctx == nil {
		return nil, errors.New("装载插件必须提供 ctx")
	}
	if c == nil {
		return nil, errors.New("装载插件必须提供 Context")
	}
	installed := make([]*kardia.Fiber, 0, len(plugins))
	var errs []error
	for _, plugin := range plugins {
		if err := ctx.Err(); err != nil {
			errs = append(errs, fmt.Errorf("装载插件已取消：%w", err))
			break
		}
		if plugin == nil {
			errs = append(errs, errors.New("装载失败：插件为空"))
			break
		}
		fiber, err := c.Plugin(plugin, nil)
		if err != nil {
			errs = append(errs, fmt.Errorf("装载插件 %q 失败：%w", plugin.Name, err))
			break
		}
		_, err = fiber.Await(ctx)
		if err == nil {
			err = ctx.Err()
		}
		if err == nil && fiber.State() != kardia.FiberActive {
			err = errors.New("插件依赖未就绪或插件未激活，请按依赖顺序装载")
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("插件 %q 未就绪：%w", plugin.Name, err))
			if disposeErr := fiber.Dispose(context.Background()); disposeErr != nil {
				errs = append(errs, disposeErr)
			}
			break
		}
		installed = append(installed, fiber)
	}
	if len(errs) == 0 {
		return installed, nil
	}
	for i := len(installed) - 1; i >= 0; i-- {
		if err := installed[i].Dispose(context.Background()); err != nil {
			errs = append(errs, fmt.Errorf("回滚已装载的 fiber 失败：%w", err))
		}
	}
	return nil, errors.Join(errs...)
}
