package database

import (
	"context"
	"errors"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// agent_test.go：AgentFacade 收缩为装配容器后的可用性门禁与接缝装配。

// stubViews 最小 seam.DockerViews 实现。
type stubViews struct{}

func (stubViews) ListImages(context.Context) ([]contract.ContainerImage, error) { return nil, nil }
func (stubViews) ListContainers(context.Context) ([]contract.Container, error)  { return nil, nil }
func (stubViews) Policy() seam.DockerPolicy                                     { return seam.DockerPolicy{} }
func (stubViews) SelfContainerID() string                                       { return "" }

func TestAgentFacadeAvailabilityFollowsEngineFacts(t *testing.T) {
	if facade := NewAgentFacade(Deps{}); facade.Available() {
		t.Fatal("无引擎事实时 Facade 不得可用")
	}
	if facade := NewAgentFacade(Deps{EngineAvailable: true}); facade.Available() {
		t.Fatal("缺 Views 时 Facade 不得可用")
	}
	facade := NewAgentFacade(Deps{EngineAvailable: true, Engine: unusedEngineTransport{}, Views: stubViews{}})
	if !facade.Available() {
		t.Fatal("引擎与视图就绪时 Facade 应可用")
	}
	// 守卫注入对不可用 Facade 是安全空操作。
	NewAgentFacade(Deps{}).SetContainerOperationGuard(func(context.Context, string, string, string) error { return nil })
}

// unusedEngineTransport 拒绝一切引擎请求的假传输器。
type unusedEngineTransport struct{}

func (unusedEngineTransport) Request(context.Context, seam.EngineRequest) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("不应请求真实引擎")
}
func (unusedEngineTransport) Stream(context.Context, seam.EngineRequest, func([]byte)) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("不应请求真实引擎")
}

func TestAgentFacadeBridgeRequiresRevalidation(t *testing.T) {
	facade := NewAgentFacade(Deps{EngineAvailable: true, Engine: unusedEngineTransport{}, Views: stubViews{}})
	bridge := facade.ContainerBridge(func(context.Context) error { return shared.InvalidRequest("授权已撤销") })
	if _, err := bridge.Registered(context.Background(), testContainerID); err == nil {
		t.Fatal("派发授权未通过时 Registered 应拒绝")
	}
	if _, err := bridge.Lifecycle(context.Background(), testContainerID, "stop"); err == nil {
		t.Fatal("派发授权未通过时 Lifecycle 应拒绝")
	}
	denied := errors.New("授权撤销")
	bridge = facade.ContainerBridge(func(context.Context) error { return denied })
	if _, err := bridge.Registered(context.Background(), testContainerID); !errors.Is(err, denied) {
		t.Fatalf("授权错误应原样上抛：%v", err)
	}
}
