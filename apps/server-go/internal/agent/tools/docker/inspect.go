package docker

import (
	"encoding/json"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

func containerSummary(c contract.Container) ContainerSummary {
	return ContainerSummary{ID: c.ID, Name: c.Name, Status: c.Status, ImageID: c.ImageID, ImageRef: c.ImageRef, Ports: append([]contract.PortBindingView{}, c.Ports...), CreatedAt: c.CreatedAt, StartedAt: c.StartedAt, RestartPolicy: c.RestartPolicy}
}
func imageSummary(c contract.ContainerImage) ImageSummary {
	var pulled *string
	if c.PulledAt != nil {
		value := *c.PulledAt
		pulled = &value
	}
	return ImageSummary{ID: c.ID, Name: c.Name, Tag: c.Tag, Digest: c.Digest, SizeMB: c.SizeMB, PulledAt: pulled, OtherTags: append([]string{}, c.OtherTags...)}
}
func (s *Service) inspectionDescriptors() []tools.Descriptor {
	id := tools.Schema{Type: tools.SchemaString, Description: "本地列表返回的完整对象 ID"}
	return []tools.Descriptor{
		{Name: "docker_container_inspect", Description: "只读查看本机指定完整 ID 容器的状态、镜像、端口、启动时间与重启策略；不返回环境变量、启动命令或挂载内容", SearchNames: []string{"容器详情", "容器状态", "查看容器", "数据库登记", "逻辑库详情", "MySQL 元数据", "MariaDB 元数据", "Redis 状态", "数据库指标", "docker inspect container", "docker container inspect"}, Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": id, "database": {Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": {Type: tools.SchemaString}, "metadata": {Type: tools.SchemaBoolean}, "metrics": {Type: tools.SchemaBoolean}}}}}, Metadata: tools.Metadata{Domain: "docker", Action: "inspect", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "2"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			container, err := s.deps.Agent.InspectContainer(tools.Lifetime(c), id)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			result := containerSummary(container)
			if tools.FrozenMetadata(tools.Lifetime(c)).Version == "1" {
				return result, nil
			}
			var selected *seam.AgentDatabaseInspection
			if raw, exists := args["database"]; exists {
				value, _ := json.Marshal(raw)
				selected = &seam.AgentDatabaseInspection{}
				if err := json.Unmarshal(value, selected); err != nil {
					return nil, err
				}
			}
			detail, err := s.deps.Agent.DatabaseContainerDetails(tools.Lifetime(c), id, selected)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			result.Database = detail
			return result, nil
		}},
		{Name: "docker_image_inspect", Description: "只读查看本机已安装镜像的完整 ID、名称、标签、摘要、大小和时间；不查询远程镜像库，不返回镜像构建历史或配置", SearchNames: []string{"本地镜像详情", "镜像信息", "镜像大小", "docker image inspect", "image inspect"}, Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": id}}, Metadata: tools.Metadata{Domain: "docker", Action: "inspect", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, ResourceType: "docker-image", ResourceKeyArgument: "id", Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			image, err := s.deps.Agent.InspectImage(tools.Lifetime(c), id)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			return imageSummary(image), nil
		}},
	}
}
