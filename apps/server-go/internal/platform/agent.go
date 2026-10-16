package platform

import (
	"context"
	"errors"

	"elysian/server/internal/seam"
)

type AgentFacade struct {
	prober    probeService
	usage     func() memoryUsage
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
	f := &AgentFacade{prober: deps.prober, usage: deps.readUsage, authorize: deps.AgentAuthorize}
	if f.prober == nil {
		f.prober = prober{createTransport: deps.Transports.New, createCaddy: deps.CaddyAdmins.New, dockerSocket: deps.DockerSocket, caddySocket: deps.CaddySocket}
	}
	if f.usage == nil {
		f.usage = processMemoryUsage
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
