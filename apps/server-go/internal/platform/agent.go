package platform

import (
	"context"
	"errors"

	"elysian/server/internal/seam"
)

type AgentFacade struct {
	prober    probeService
	usage     func() memoryUsage
	metrics   func() platformMetricsSample
	authorize func(context.Context) error
}

func NewAgentFacade(deps Deps) *AgentFacade {
	if deps.Transports == nil {
		deps.Transports = seam.NoopTransportFactory()
	}
	if deps.CaddyAdmins == nil {
		deps.CaddyAdmins = noopCaddyAdminFactory{}
	}
	if deps.DockerSocket == "" {
		deps.DockerSocket = defaultDockerSocketPath
	}
	if deps.CaddySocket == "" {
		deps.CaddySocket = defaultCaddySocketPath
	}
	f := &AgentFacade{prober: deps.prober, usage: deps.readUsage, metrics: deps.readMetrics, authorize: deps.AgentAuthorize}
	if f.prober == nil {
		f.prober = prober{createTransport: deps.Transports.New, createCaddy: deps.CaddyAdmins.New, dockerSocket: deps.DockerSocket, caddySocket: deps.CaddySocket}
	}
	if f.usage == nil {
		f.usage = processMemoryUsage
	}
	if f.metrics == nil {
		f.metrics = func() platformMetricsSample { return readHostMetrics(defaultHostMetricsSource()) }
	}
	return f
}

func (f *AgentFacade) Memory(ctx context.Context) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f == nil || f.authorize == nil {
		return nil, errors.New("平台只读能力未授权")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, err
	}
	return sampleFromUsage(f.usage()), ctx.Err()
}

// Sample 在一次派发内取进程与宿主采样。后端票据每次派发只能消费一次，因此两份
// 读数必须共用这一个授权入口，不能由调用方连续调 Memory 与 Metrics。
func (f *AgentFacade) Sample(ctx context.Context, wantProcess, wantHost bool) (process any, host any, err error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if f == nil || f.authorize == nil {
		return nil, nil, errors.New("平台只读能力未授权")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, nil, err
	}
	if wantProcess {
		process = sampleFromUsage(f.usage())
	}
	if wantHost {
		host = f.metrics()
	}
	return process, host, ctx.Err()
}

func (f *AgentFacade) Dependencies(ctx context.Context) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f == nil || f.authorize == nil {
		return nil, errors.New("平台只读能力未授权")
	}
	if err := f.authorize(ctx); err != nil {
		return nil, err
	}
	report := f.prober.Probe()
	// Probe details are engine-controlled text. The Agent receives states only.
	return map[string]any{"docker": report.Docker.State, "caddy": report.Caddy.State}, ctx.Err()
}
