package seam

import (
	"context"
	"errors"

	"elysian/server/internal/contract"
)

// 骨架桩实现（go-plan §4.1 末段）：保证骨架可编译、域可单测。域实现落地后由真实
// 实现替代，桩保留供测试注入。

// NoopPortOpener 恒 skipped 的端口开放桩：防火墙片不可用时装配层注入它，行为逐字对齐
// TS 版「测试注入的防火墙片没有 hostDeps，恒报 skipped 不打扰」。
func NoopPortOpener() PortOpener { return noopPortOpener{} }

type noopPortOpener struct{}

// EnsurePortRule 恒回 skipped + 固定中文说明。
func (noopPortOpener) EnsurePortRule(_ context.Context, port int, _ string) contract.FirewallPortSync {
	return contract.FirewallPortSync{
		State:  contract.FirewallPortSyncSkipped,
		Port:   port,
		Detail: ptr(contract.FirewallPortSyncDetailSkipped),
	}
}

// NoopTransportFactory 产出恒错误传输器的工厂桩：探测路径在骨架期不接真实 Engine。
func NoopTransportFactory() DockerTransportFactory { return noopTransportFactory{} }

type noopTransportFactory struct{}

// New 返回一个恒回「未接线」错误的传输器。
func (noopTransportFactory) New(string) DockerTransport { return noopTransport{} }

type noopTransport struct{}

func (noopTransport) Request(context.Context, EngineRequest) (EngineResponse, error) {
	return EngineResponse{}, errors.New("Docker Engine 通道尚未接线")
}

func (noopTransport) Stream(context.Context, EngineRequest, func([]byte)) (EngineResponse, error) {
	return EngineResponse{}, errors.New("Docker Engine 通道尚未接线")
}

func ptr(s string) *string { return &s }
