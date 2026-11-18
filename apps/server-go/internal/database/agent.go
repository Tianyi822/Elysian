package database

import (
	"path/filepath"

	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
)

// AgentFacade 装配容器：持有页面共享的 databaseService，并把容器登记接缝
// （seam.AgentDatabaseContainers）提供给 docker 域路由数据库容器生命周期。
// 模型面方法（list/metadata/metrics/discover/create/任务服务）已随数据库
// 逻辑库概念退役；凭据不跨过本接口。
type AgentFacade struct {
	service *databaseService
}

func NewAgentFacade(deps Deps) *AgentFacade {
	f := &AgentFacade{}
	if deps.EngineAvailable && deps.Engine != nil && deps.Views != nil {
		f.service = newDatabaseService(serviceDeps{
			registry:        newFileDatabaseRegistry(filepath.Join(paths.ConfigDir, "databases.json")),
			docker:          newDockerAPI(deps.Engine, deps.Views.ListImages, deps.Views.Policy().ReservedPorts),
			listContainers:  deps.Views.ListContainers,
			listImages:      deps.Views.ListImages,
			selfContainerID: deps.SelfID,
			portOpener:      deps.PortOpener,
		})
	}
	return f
}

func (f *AgentFacade) Available() bool { return f != nil && f.service != nil }

func (f *AgentFacade) SetContainerOperationGuard(guard seam.ContainerOperationGuard) {
	if f.Available() {
		f.service.operationGuard = guard
	}
}
