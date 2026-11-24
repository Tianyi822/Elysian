package docker

import (
	"context"
	"math"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"

	"elysian/server/internal/contract"
)

type agentNetworkEndpoint struct {
	Name string `json:"name"`
	ID   string `json:"id,omitempty"`
	IPv4 string `json:"ipv4,omitempty"`
	IPv6 string `json:"ipv6,omitempty"`
}

type agentContainerMount struct {
	Type        string `json:"type"`
	Name        string `json:"name,omitempty"`
	Destination string `json:"destination"`
	Source      string `json:"source,omitempty"`
	Writable    bool   `json:"writable"`
}

type ContainerDetail struct {
	Health            string                 `json:"health,omitempty"`
	ExitCode          *int64                 `json:"exitCode"`
	OOMKilled         *bool                  `json:"oomKilled"`
	NetworkMode       string                 `json:"networkMode"`
	Networks          []agentNetworkEndpoint `json:"networks"`
	Mounts            []agentContainerMount  `json:"mounts"`
	EnvKeys           []string               `json:"envKeys"`
	Program           string                 `json:"program,omitempty"`
	ArgumentCount     int                    `json:"argumentCount"`
	Compose           map[string]string      `json:"compose,omitempty"`
	MemoryLimitBytes  *int64                 `json:"memoryLimitBytes"`
	NanoCPUs          *int64                 `json:"nanoCpus"`
	CPUQuota          *int64                 `json:"cpuQuota"`
	CPUPeriod         *int64                 `json:"cpuPeriod"`
	PIDsLimit         *int64                 `json:"pidsLimit"`
	RestartMaxRetries *int64                 `json:"restartMaxRetries"`
	AgentTargetNotes
}

func agentField(row *jsonObject, key string) any {
	if row == nil {
		return nil
	}
	return mustGet(row, key)
}

func agentRecord(row *jsonObject, key string) *jsonObject {
	child, _ := asRecord(agentField(row, key))
	return child
}

func agentText(row *jsonObject, key string) string {
	value, _ := asString(agentField(row, key))
	return value
}

func agentInt(row *jsonObject, key string) *int64 {
	value, ok := asNumber(agentField(row, key))
	if !ok || value < math.MinInt64 || value >= -float64(math.MinInt64) || math.Trunc(value) != value {
		return nil
	}
	number := int64(value)
	return &number
}

func agentBool(row *jsonObject, key string) *bool {
	value, ok := agentField(row, key).(bool)
	if !ok {
		return nil
	}
	return &value
}

func agentCompose(labels *jsonObject) map[string]string {
	result := map[string]string{}
	for _, key := range []string{"project", "service", "network", "volume", "container-number"} {
		if value := agentText(labels, "com.docker.compose."+key); value != "" {
			result[key] = value
		}
	}
	return result
}

func (a *AgentFacade) readHostTarget(ctx context.Context, id string) (any, error) {
	value, err := a.inspectHostTarget(ctx, id)
	if err == nil {
		err = readableAgentTarget(value, a.service.deps.selfContainerID)
	}
	return value, agentRejected(err)
}

func (a *AgentFacade) InspectHostContainer(ctx context.Context, id string, detail bool) (contract.Container, ContainerDetail, error) {
	if err := a.check(ctx); err != nil {
		return contract.Container{}, ContainerDetail{}, err
	}
	value, err := a.readHostTarget(ctx, id)
	if err != nil {
		return contract.Container{}, ContainerDetail{}, err
	}
	container, err := mapContainer(value)
	if err != nil || !detail {
		return container, ContainerDetail{}, err
	}
	return container, projectContainerDetail(value, a.service.deps.selfContainerID), nil
}

func projectContainerDetail(value any, selfID string) ContainerDetail {
	row, _ := asRecord(value)
	config, host, state := agentRecord(row, "Config"), agentRecord(row, "HostConfig"), agentRecord(row, "State")
	result := ContainerDetail{
		Health: agentText(agentRecord(state, "Health"), "Status"), ExitCode: agentInt(state, "ExitCode"),
		OOMKilled: agentBool(state, "OOMKilled"), NetworkMode: agentText(host, "NetworkMode"),
		Networks: []agentNetworkEndpoint{}, Mounts: []agentContainerMount{}, EnvKeys: []string{},
		Compose: agentCompose(agentRecord(config, "Labels")), MemoryLimitBytes: agentInt(host, "Memory"),
		NanoCPUs: agentInt(host, "NanoCpus"), CPUQuota: agentInt(host, "CpuQuota"), CPUPeriod: agentInt(host, "CpuPeriod"),
		PIDsLimit: agentInt(host, "PidsLimit"), RestartMaxRetries: agentInt(agentRecord(host, "RestartPolicy"), "MaximumRetryCount"),
		AgentTargetNotes: describeAgentTarget(value, selfID),
	}
	if program := agentText(row, "Path"); program != "" {
		result.Program = path.Base(program)
	}
	args, _ := asArray(agentField(row, "Args"))
	result.ArgumentCount = len(args)
	env, _ := asArray(agentField(config, "Env"))
	keys := map[string]bool{}
	for _, entry := range env {
		text, _ := asString(entry)
		if key, _, found := strings.Cut(text, "="); found && key != "" && !keys[key] {
			keys[key] = true
			result.EnvKeys = append(result.EnvKeys, key)
		}
	}
	sort.Strings(result.EnvKeys)
	networks := agentRecord(agentRecord(row, "NetworkSettings"), "Networks")
	if networks != nil {
		names := networks.orderedKeys()
		sort.Strings(names)
		for _, name := range names {
			network := agentRecord(networks, name)
			result.Networks = append(result.Networks, agentNetworkEndpoint{
				Name: name, ID: agentText(network, "NetworkID"), IPv4: agentText(network, "IPAddress"), IPv6: agentText(network, "GlobalIPv6Address"),
			})
		}
	}
	mounts, _ := asArray(agentField(row, "Mounts"))
	for _, value := range mounts {
		mount, ok := asRecord(value)
		if !ok {
			continue
		}
		item := agentContainerMount{
			Type: agentText(mount, "Type"), Name: agentText(mount, "Name"), Destination: agentText(mount, "Destination"),
			Writable: agentField(mount, "RW") == true,
		}
		if result.Ownership == string(targetUser) || result.Ownership == string(targetPanel) {
			item.Source = agentText(mount, "Source")
		}
		result.Mounts = append(result.Mounts, item)
	}
	return result
}

type agentContainerStats struct {
	ID               string   `json:"id"`
	Status           string   `json:"status"`
	CPUPercent       *float64 `json:"cpuPercent"`
	MemoryMiB        *float64 `json:"memoryMiB"`
	MemoryLimitBytes *int64   `json:"memoryLimitBytes"`
	PIDs             *int64   `json:"pids"`
	PIDsLimit        *int64   `json:"pidsLimit"`
	NetworkRxBytes   *int64   `json:"networkRxBytes"`
	NetworkTxBytes   *int64   `json:"networkTxBytes"`
	BlockReadBytes   *int64   `json:"blockReadBytes"`
	BlockWriteBytes  *int64   `json:"blockWriteBytes"`
}

func (a *AgentFacade) ContainerStats(ctx context.Context, id string) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, actionTimeout)
	defer cancel()
	value, err := a.readHostTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	row, _ := asRecord(value)
	state := agentRecord(row, "State")
	result := agentContainerStats{ID: id, Status: agentText(state, "Status")}
	if agentField(state, "Running") != true && result.Status != "running" {
		return result, nil
	}
	value, err = a.readEngineProjection(ctx, "/containers/"+id+"/stats", url.Values{"stream": {"false"}}, "读取容器统计失败")
	if err != nil {
		return nil, err
	}
	stats, ok := asRecord(value)
	if !ok {
		return nil, &AgentError{Code: "docker-observation-failed", Message: "容器统计响应格式无效"}
	}
	if cpu, ok := cpuPercent(stats); ok {
		result.CPUPercent = &cpu
	}
	if memory, ok := memoryMb(stats); ok {
		result.MemoryMiB = &memory
	}
	result.MemoryLimitBytes = agentInt(agentRecord(stats, "memory_stats"), "limit")
	result.PIDs = agentInt(agentRecord(stats, "pids_stats"), "current")
	result.PIDsLimit = agentInt(agentRecord(stats, "pids_stats"), "limit")
	if networks := agentRecord(stats, "networks"); networks != nil {
		for _, name := range networks.orderedKeys() {
			network := agentRecord(networks, name)
			addAgentCounter(&result.NetworkRxBytes, agentInt(network, "rx_bytes"))
			addAgentCounter(&result.NetworkTxBytes, agentInt(network, "tx_bytes"))
		}
	}
	operations, _ := asArray(agentField(agentRecord(stats, "blkio_stats"), "io_service_bytes_recursive"))
	for _, entry := range operations {
		operation, _ := asRecord(entry)
		counter := agentInt(operation, "value")
		switch strings.ToLower(agentText(operation, "op")) {
		case "read":
			addAgentCounter(&result.BlockReadBytes, counter)
		case "write":
			addAgentCounter(&result.BlockWriteBytes, counter)
		}
	}
	return result, nil
}

func addAgentCounter(total **int64, increment *int64) {
	if increment == nil || *increment < 0 {
		return
	}
	if *total == nil {
		newTotal := *increment
		*total = &newTotal
	} else if **total <= math.MaxInt64-*increment {
		**total += *increment
	} else {
		**total = math.MaxInt64
	}
}

func (a *AgentFacade) readEngineProjection(ctx context.Context, endpoint string, query url.Values, message string) (any, error) {
	status, data, err := a.service.engineJSON(ctx, http.MethodGet, endpoint, query, nil, actionTimeout)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil || status != http.StatusOK {
		return nil, &AgentError{Code: "docker-observation-failed", Message: message}
	}
	return data, nil
}
