// Package toolbridge 把宿主持有的 Docker 视图接到受限工具注册表。
// 它不创建域对象，也不把 kardia 或域传输器交给 Worker。
package toolbridge

import (
	"context"
	"errors"
	"sync"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	dockertools "elysian/server/internal/agent/tools/docker"
	"elysian/server/internal/seam"
)

var allowedTools = map[string]bool{
	"docker_containers_list": true,
	"docker_images_list":     true,
	"docker_policy_view":     true,
	"docker_self_container":  true,
}

// Bridge 持有工具插件与调用作用域；真实域对象仍归宿主所有。
type Bridge struct {
	mu        sync.Mutex
	root      *kardia.Context
	registry  *tools.Registry
	closed    bool
	closeOnce sync.Once
	closeDone chan struct{}
	closeErr  error
}

// New 允许无 Docker 视图时构造不可用接缝，历史读取不依赖 Docker 就绪。
func New(views seam.DockerViews) (*Bridge, error) {
	b := &Bridge{closeDone: make(chan struct{})}
	if tools.IsNil(views) {
		return b, nil
	}
	b.root = kardia.NewContext()
	// 多读一条用于上层判定是否截断；内核持久化与公开结果至多 200 条。
	if _, err := tools.Install(context.Background(), b.root, tools.Plugin,
		dockertools.Plugin(dockertools.Deps{Views: views}, dockertools.Config{ListLimit: 201})); err != nil {
		_ = b.root.Fiber().Dispose(context.Background())
		return nil, errors.New("装载 Agent Docker 工具失败")
	}
	registry, err := tools.RegistryFrom(b.root)
	if err != nil {
		_ = b.root.Fiber().Dispose(context.Background())
		return nil, errors.New("Agent 工具注册表未就绪")
	}
	b.registry = registry
	return b, nil
}

// Available 只报告接缝是否装载；每次 Docker 请求仍核验实际引擎状态。
func (b *Bridge) Available() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.closed && b.registry != nil
}

// Schemas 只公开四条允许的工具，返回独立的模式快照。
func (b *Bridge) Schemas() []tools.PublicSchema {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := []tools.PublicSchema{}
	if b.closed || b.registry == nil {
		return result
	}
	for _, schema := range b.registry.Schemas() {
		if allowedTools[schema.Name] {
			switch schema.Name {
			case "docker_containers_list":
				schema.Description = "列出容器摘要，最多 200 条；超限时标记截断"
			case "docker_images_list":
				schema.Description = "列出镜像摘要，最多 200 条；超限时标记截断"
			}
			result = append(result, schema)
		}
	}
	return result
}

type callResult struct {
	value any
	err   error
}

// Execute 直到域调用真正退出才返回。内核独立等待取消宽限；不能把已发送取消
// 冒充调用完成，否则不协作的域请求会在释放执行槽后继续积累。
func (b *Bridge) Execute(ctx context.Context, name string, args map[string]any) (any, error) {
	if ctx == nil {
		return nil, errors.New("工具调用必须提供上下文")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !allowedTools[name] {
		return nil, errors.New("该工具不在 Agent 只读允许清单内")
	}
	b.mu.Lock()
	if b.closed || b.registry == nil {
		b.mu.Unlock()
		return nil, errors.New("Agent Docker 工具不可用")
	}
	completed := make(chan callResult, 1)
	handle, err := b.root.Scope().Iter("harness.tool-call", func(_ context.Context, scope *kardia.EffectScope) error {
		outcome := callResult{}
		defer func() {
			if recover() != nil {
				outcome = callResult{err: errors.New("工具执行发生内部错误")}
			}
			completed <- outcome
		}()
		access, bindErr := scope.Bind(b.root)
		if bindErr != nil {
			outcome.err = errors.New("工具调用作用域不可用")
			return nil
		}
		outcome.value, outcome.err = b.registry.Execute(access, name, args)
		if outcome.err != nil && !errors.Is(outcome.err, context.Canceled) && !errors.Is(outcome.err, context.DeadlineExceeded) {
			// 域错误可能含引擎原始响应，不进入任务库或跨进程协议。
			outcome.err = errors.New("Docker 工具执行失败，请检查引擎状态与调用参数")
		}
		return nil
	})
	b.mu.Unlock()
	if err != nil {
		return nil, errors.New("无法创建工具调用作用域")
	}
	stopCancellation := context.AfterFunc(ctx, func() {
		cancelled, cancel := context.WithCancel(context.Background())
		cancel()
		// Dispose 先取消 scope，再等待清理；已取消的等待上下文让回调及时返回。
		_ = handle.Dispose(cancelled)
	})
	defer stopCancellation()
	outcome := <-completed
	if disposeErr := handle.Dispose(context.Background()); disposeErr != nil {
		outcome.err = errors.Join(outcome.err, errors.New("回收工具调用作用域失败"))
	}
	return outcome.value, outcome.err
}

// Close 停止新调用并取消所有在途 scope；ctx 只限定等待时间，重复关闭可继续等待。
func (b *Bridge) Close(ctx context.Context) error {
	if ctx == nil {
		return errors.New("关闭工具接缝必须提供上下文")
	}
	b.closeOnce.Do(func() {
		b.mu.Lock()
		b.closed = true
		b.mu.Unlock()
		go func() {
			if b.root != nil {
				b.closeErr = b.root.Fiber().Dispose(context.Background())
			}
			close(b.closeDone)
		}()
	})
	select {
	case <-b.closeDone:
		return b.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
