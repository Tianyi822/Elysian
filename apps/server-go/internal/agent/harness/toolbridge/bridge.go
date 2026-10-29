// Package toolbridge 把宿主持有的 Docker 视图接到受限工具注册表。
// 它不创建域对象，也不把 kardia 或域传输器交给 Worker。
package toolbridge

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	dockertools "elysian/server/internal/agent/tools/docker"
	"elysian/server/internal/seam"
)

var legacyTools = map[string]bool{
	"docker_containers_list": true,
	"docker_images_list":     true,
	"docker_policy_view":     true,
	"docker_self_container":  true,
}

// Bridge 持有工具插件与调用作用域；真实域对象仍归宿主所有。
type Bridge struct {
	runtime *tools.Runtime
	legacy  bool
}

// New 允许无 Docker 视图时构造不可用接缝，历史读取不依赖 Docker 就绪。
func New(views seam.DockerViews) (*Bridge, error) {
	b := &Bridge{legacy: true}
	if tools.IsNil(views) {
		return b, nil
	}
	// 多读一条用于上层判定是否截断；内核持久化与公开结果至多 200 条。
	runtime, err := tools.NewRuntime(context.Background(),
		dockertools.Plugin(dockertools.Deps{Views: views}, dockertools.Config{ListLimit: 201}))
	if err != nil {
		return nil, errors.New("装载 Agent Docker 工具失败")
	}
	b.runtime = runtime
	return b, nil
}

// NewWithPlugins is the production catalog. Each injected domain plugin owns
// its resource lifecycle; availability is evaluated by the individual handler.
func NewWithPlugins(views seam.DockerViews, plugins ...*kardia.Plugin) (*Bridge, error) {
	hasDocker := false
	for _, plugin := range plugins {
		if plugin != nil && plugin.Name == dockertools.ServiceName {
			hasDocker = true
		}
	}
	if !hasDocker && !tools.IsNil(views) {
		plugins = append([]*kardia.Plugin{dockertools.Plugin(dockertools.Deps{Views: views}, dockertools.Config{ListLimit: 201})}, plugins...)
	}
	runtime, err := tools.NewManagedRuntime(context.Background(), plugins...)
	if err != nil {
		return nil, err
	}
	return &Bridge{runtime: runtime}, nil
}

func (b *Bridge) Runtime() *tools.Runtime {
	if b == nil {
		return nil
	}
	return b.runtime
}

func (b *Bridge) SetAuthority(authority *tools.Authority) error {
	if b == nil || b.runtime == nil {
		return nil
	}
	return b.runtime.SetAuthority(authority)
}

// Available 只报告接缝是否装载；每次 Docker 请求仍核验实际引擎状态。
func (b *Bridge) Available() bool {
	return b != nil && b.runtime != nil && b.runtime.Available()
}

// Schemas 返回独立的模式快照；旧桥接只公开四条只读工具，生产目录按 agent 可见性筛选。
func (b *Bridge) Schemas() []tools.PublicSchema {
	if b == nil || b.runtime == nil {
		return []tools.PublicSchema{}
	}
	result := []tools.PublicSchema{}
	for _, schema := range b.runtime.Schemas() {
		if (b.legacy && legacyTools[schema.Name]) || (!b.legacy && schema.Metadata.Exposure == "agent") {
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

// callResult is kept for package-level bridge tests that coordinate a call
// goroutine; runtime execution itself uses tools.Runtime's private result.
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
	if b != nil && b.legacy && !legacyTools[name] {
		return nil, errors.New("该工具不在 Agent 只读允许清单内")
	}
	if b == nil || b.runtime == nil {
		return nil, errors.New("Agent Docker 工具不可用")
	}
	value, err := b.runtime.Execute(ctx, name, args)
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		// 域错误可能含引擎原始响应，不进入任务库或跨进程协议。
		return nil, errors.New("Docker 工具执行失败，请检查引擎状态与调用参数")
	}
	return value, err
}

// Close 停止新调用并取消所有在途 scope；ctx 只限定等待时间，重复关闭可继续等待。
func (b *Bridge) Close(ctx context.Context) error {
	if b == nil || b.runtime == nil {
		return nil
	}
	return b.runtime.Close(ctx)
}
