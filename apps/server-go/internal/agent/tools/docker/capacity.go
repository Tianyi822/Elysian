package docker

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
)

// capacityDescriptor 是创建容器前的宿主容量预检入口：只读、无参数，提交创建时会按同一
// 口径再核对一次，模型用它先确认可容纳的档位再向用户提问。
func (s *Service) capacityDescriptor() tools.Descriptor {
	return tools.Descriptor{
		Name:        "docker_host_capacity",
		Description: "只读核对创建容器前的宿主容量：返回可用内存、系统保留量与 small/medium/large 各档位当前能否容纳，读数不可得时明确说明。不创建任何资源；提交创建时会按同一口径再核对一次",
		SearchNames: []string{"宿主容量", "资源够不够", "内存够用", "容量预检", "创建容器前检查", "host capacity"},
		Parameters:  tools.Schema{Type: tools.SchemaObject},
		Metadata:    tools.Metadata{Domain: "docker", Action: "host_capacity", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"},
		Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
			value, err := s.deps.Agent.HostCapacity(tools.Lifetime(c))
			return value, agentBusinessError(err)
		},
	}
}
