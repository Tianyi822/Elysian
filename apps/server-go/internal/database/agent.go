package database

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// AgentFacade 装配容器：持有页面共享的 databaseService，把容器登记接缝
// （seam.AgentDatabaseContainers）提供给 docker 域路由数据库容器生命周期，并承载
// Agent 的数据库部署入口（受理前核对、持久任务账本与执行）。凭据不跨过本接口。
type AgentFacade struct {
	service *databaseService
	// authorize 核验 Agent 派发票据；nil 表示未开放 Agent 部署。
	authorize func(context.Context) error
	// operationRoot 是部署任务账本目录。
	operationRoot   string
	operationMu     sync.Mutex
	targetLocks     map[string]chan struct{}
	operations      map[string]ProvisionTask
	operationCancel map[string]context.CancelFunc
	operationWG     sync.WaitGroup
	operationClosed bool
	now             func() time.Time
}

func NewAgentFacade(deps Deps) *AgentFacade {
	f := &AgentFacade{}
	if deps.EngineAvailable && deps.Engine != nil && deps.Views != nil {
		docker := newDockerAPI(deps.Engine, deps.Views.ListImages, deps.Views.Policy().ReservedPorts)
		f.service = newDatabaseService(serviceDeps{
			registry:        newFileDatabaseRegistry(filepath.Join(paths.ConfigDir, "databases.json")),
			docker:          docker,
			admin:           docker,
			listContainers:  deps.Views.ListContainers,
			listImages:      deps.Views.ListImages,
			selfContainerID: deps.SelfID,
			portOpener:      deps.PortOpener,
			hostCapacity:    deps.HostCapacity,
			reservedPorts:   deps.Views.Policy().ReservedPorts,
		})
		f.authorize = deps.AgentAuthorize
		// 容器级操作与解除接管前核对该实例的在途部署；账本在 facade 上，经回调给服务层。
		f.service.deps.provisionMutation = f.BeginContainerMutation
	}
	return f
}

// lockProvisionTarget reserves both aliases atomically. Only a submitting
// deployment waits for a short-lived reservation; container operations fail fast.
func (f *AgentFacade) lockProvisionTarget(ctx context.Context, id, name string, wait bool) (func(), error) {
	keys := make([]string, 0, 2)
	if id != "" {
		keys = append(keys, "id:"+id)
	}
	if name != "" {
		keys = append(keys, "name:"+name)
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		f.operationMu.Lock()
		var busy chan struct{}
		for _, key := range keys {
			if f.targetLocks[key] != nil {
				busy = f.targetLocks[key]
				break
			}
		}
		if busy == nil {
			done := make(chan struct{})
			if f.targetLocks == nil {
				f.targetLocks = make(map[string]chan struct{})
			}
			for _, key := range keys {
				f.targetLocks[key] = done
			}
			f.operationMu.Unlock()
			return func() {
				f.operationMu.Lock()
				for _, key := range keys {
					delete(f.targetLocks, key)
				}
				close(done)
				f.operationMu.Unlock()
			}, nil
		}
		f.operationMu.Unlock()
		if !wait {
			return nil, shared.Conflict("该容器正在受理数据库部署或执行其他操作")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-busy:
		}
	}
}

// BeginContainerMutation holds the reservation through the caller's write and readback.
func (f *AgentFacade) BeginContainerMutation(ctx context.Context, id, name string) (func(), error) {
	if !f.Available() {
		return func() {}, nil
	}
	release, err := f.lockProvisionTarget(ctx, id, name, false)
	if err != nil {
		return nil, err
	}
	f.operationMu.Lock()
	err = f.checkProvisionConflictLocked(id, name)
	f.operationMu.Unlock()
	if err != nil {
		release()
		return nil, err
	}
	return release, nil
}

func (f *AgentFacade) checkProvisionConflictLocked(id, name string) error {
	if err := f.loadProvisions(); err != nil {
		return err
	}
	for _, task := range f.operations {
		if provisionBlocks(task) && (id != "" && task.InstanceID == id || name != "" && task.InstanceName == name) {
			return shared.Conflict("该实例已有进行中或结果未确认的部署，请先核实部署结果")
		}
	}
	return nil
}

func (f *AgentFacade) Available() bool { return f != nil && f.service != nil }

// checkProvision 是 Agent 部署入口的授权闸门。
func (f *AgentFacade) checkProvision(ctx context.Context) error {
	if f == nil || f.service == nil || f.authorize == nil {
		return errors.New("数据库部署能力未装配或未授权")
	}
	return f.authorize(ctx)
}

// Instances 返回本机数据库实例的 Agent 投影，不含凭据值。
func (f *AgentFacade) Instances(ctx context.Context, engine, version string) (InstancesReport, error) {
	if err := f.checkProvision(ctx); err != nil {
		return InstancesReport{}, err
	}
	return f.service.instancesReport(ctx, engine, version)
}

func (f *AgentFacade) SetContainerOperationGuard(guard seam.ContainerOperationGuard) {
	if f.Available() {
		f.service.operationGuard = guard
	}
}
