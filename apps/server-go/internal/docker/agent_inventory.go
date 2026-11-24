package docker

import (
	"context"
	"net/url"
	"slices"
	"sort"
	"strings"
)

type agentInventory[T any] struct {
	Items               []T  `json:"items"`
	Truncated           bool `json:"truncated"`
	MembershipAvailable bool `json:"membershipAvailable"`
}

type agentInventoryContainer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type agentNetworkSubnet struct {
	Subnet  string `json:"subnet,omitempty"`
	Gateway string `json:"gateway,omitempty"`
}

type agentNetwork struct {
	ID         string                    `json:"id"`
	Name       string                    `json:"name"`
	Driver     string                    `json:"driver"`
	Scope      string                    `json:"scope"`
	Internal   bool                      `json:"internal"`
	Attachable bool                      `json:"attachable"`
	Subnets    []agentNetworkSubnet      `json:"subnets"`
	Containers []agentInventoryContainer `json:"containers"`
	Compose    map[string]string         `json:"compose,omitempty"`
}

type agentVolume struct {
	Name      string                    `json:"name"`
	Driver    string                    `json:"driver"`
	CreatedAt string                    `json:"createdAt,omitempty"`
	UsedBy    []agentInventoryContainer `json:"usedBy"`
	Compose   map[string]string         `json:"compose,omitempty"`
}

func (a *AgentFacade) NetworkInventory(ctx context.Context, limit int) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, actionTimeout)
	defer cancel()
	value, err := a.readEngineProjection(ctx, "/networks", nil, "读取 Docker 网络失败")
	if err != nil {
		return nil, err
	}
	rows, ok := asArray(value)
	if !ok {
		return nil, inventoryShapeError("网络")
	}
	members, _, available, err := a.inventoryMembership(ctx)
	if err != nil {
		return nil, err
	}
	result := agentInventory[agentNetwork]{Items: []agentNetwork{}, MembershipAvailable: available}
	for _, value := range rows {
		row, _ := asRecord(value)
		item := agentNetwork{
			ID: agentText(row, "Id"), Name: agentText(row, "Name"), Driver: agentText(row, "Driver"), Scope: agentText(row, "Scope"),
			Internal: agentField(row, "Internal") == true, Attachable: agentField(row, "Attachable") == true,
			Subnets: []agentNetworkSubnet{}, Compose: agentCompose(agentRecord(row, "Labels")),
		}
		if item.ID == "" || item.Name == "" {
			return nil, inventoryShapeError("网络")
		}
		subnets, _ := asArray(agentField(agentRecord(row, "IPAM"), "Config"))
		for _, entry := range subnets {
			subnet, _ := asRecord(entry)
			item.Subnets = append(item.Subnets, agentNetworkSubnet{Subnet: agentText(subnet, "Subnet"), Gateway: agentText(subnet, "Gateway")})
		}
		result.Items = append(result.Items, item)
	}
	sort.Slice(result.Items, func(i, j int) bool {
		left, right := result.Items[i], result.Items[j]
		if left.Name == right.Name {
			return left.ID < right.ID
		}
		return left.Name < right.Name
	})
	result.Items, result.Truncated = limitInventory(result.Items, limit)
	budget := limit
	for i := range result.Items {
		item := &result.Items[i]
		item.Containers = inventoryLinks(members[item.ID], &budget, &result.Truncated)
	}
	return result, nil
}

func (a *AgentFacade) VolumeInventory(ctx context.Context, limit int) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, actionTimeout)
	defer cancel()
	value, err := a.readEngineProjection(ctx, "/volumes", nil, "读取 Docker 卷失败")
	if err != nil {
		return nil, err
	}
	response, ok := asRecord(value)
	if !ok {
		return nil, inventoryShapeError("卷")
	}
	rows, ok := asArray(agentField(response, "Volumes"))
	if !ok && agentField(response, "Volumes") != nil {
		return nil, inventoryShapeError("卷")
	}
	_, members, available, err := a.inventoryMembership(ctx)
	if err != nil {
		return nil, err
	}
	result := agentInventory[agentVolume]{Items: []agentVolume{}, MembershipAvailable: available}
	for _, value := range rows {
		row, _ := asRecord(value)
		item := agentVolume{
			Name: agentText(row, "Name"), Driver: agentText(row, "Driver"), CreatedAt: agentText(row, "CreatedAt"),
			Compose: agentCompose(agentRecord(row, "Labels")),
		}
		if item.Name == "" {
			return nil, inventoryShapeError("卷")
		}
		result.Items = append(result.Items, item)
	}
	sort.Slice(result.Items, func(i, j int) bool { return result.Items[i].Name < result.Items[j].Name })
	result.Items, result.Truncated = limitInventory(result.Items, limit)
	budget := limit
	for i := range result.Items {
		item := &result.Items[i]
		item.UsedBy = inventoryLinks(members[item.Name], &budget, &result.Truncated)
	}
	return result, nil
}

func limitInventory[T any](items []T, limit int) ([]T, bool) {
	if len(items) > limit {
		return items[:limit], true
	}
	return items, false
}

func inventoryLinks(items []agentInventoryContainer, budget *int, truncated *bool) []agentInventoryContainer {
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	items = slices.CompactFunc(items, func(a, b agentInventoryContainer) bool { return a.ID == b.ID })
	items, clipped := limitInventory(items, *budget)
	*truncated = *truncated || clipped
	*budget -= len(items)
	if items == nil {
		return []agentInventoryContainer{}
	}
	return items
}

func inventoryShapeError(name string) error {
	return &AgentError{Code: "docker-observation-failed", Message: "Docker " + name + "清单响应格式无效"}
}

func (a *AgentFacade) inventoryMembership(ctx context.Context) (networks, volumes map[string][]agentInventoryContainer, available bool, err error) {
	if a.PanelRuntime() == "unknown" {
		return nil, nil, false, nil
	}
	value, err := a.readEngineProjection(ctx, "/containers/json", url.Values{"all": {"1"}}, "读取容器引用关系失败")
	if err != nil {
		return nil, nil, false, err
	}
	rows, ok := asArray(value)
	if !ok {
		return nil, nil, false, inventoryShapeError("容器")
	}
	networks = map[string][]agentInventoryContainer{}
	volumes = map[string][]agentInventoryContainer{}
	for _, value := range rows {
		row, _ := asRecord(value)
		id := agentText(row, "Id")
		if _, err := agentObjectID(id, false); err != nil {
			return nil, nil, false, inventoryShapeError("容器")
		}
		if id == a.service.deps.selfContainerID {
			continue
		}
		rawLabels := agentField(row, "Labels")
		labels, valid := asRecord(rawLabels)
		class := classifyAgentLabels(labels)
		if (rawLabels != nil && !valid) || class == targetInternal || class == targetExecution {
			continue
		}
		container := agentInventoryContainer{ID: id}
		names, _ := asArray(agentField(row, "Names"))
		if len(names) > 0 {
			name, _ := asString(names[0])
			container.Name = strings.TrimPrefix(name, "/")
		}
		if endpoints := agentRecord(agentRecord(row, "NetworkSettings"), "Networks"); endpoints != nil {
			for _, name := range endpoints.orderedKeys() {
				if networkID := agentText(agentRecord(endpoints, name), "NetworkID"); networkID != "" {
					networks[networkID] = append(networks[networkID], container)
				}
			}
		}
		mounts, _ := asArray(agentField(row, "Mounts"))
		for _, value := range mounts {
			mount, _ := asRecord(value)
			if name := agentText(mount, "Name"); name != "" && agentText(mount, "Type") == "volume" {
				volumes[name] = append(volumes[name], container)
			}
		}
	}
	return networks, volumes, true, nil
}
