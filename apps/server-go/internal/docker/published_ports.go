package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// inspectPortBindings keeps address families separate and preserves the wildcard
// in stopped containers' HostConfig, where an empty HostIp means any address.
func inspectPortBindings(id string, value any, configured bool) ([]contract.DockerPublishedPort, error) {
	root, ok := asRecord(value)
	if !ok || !agentOperationIDPattern.MatchString(id) || mustGet(root, "Id") != id {
		return nil, errors.New("无法确认 Docker 容器身份")
	}
	parent, key := "NetworkSettings", "Ports"
	if configured {
		parent, key = "HostConfig", "PortBindings"
	}
	section, ok := asRecord(mustGet(root, parent))
	if !ok {
		return nil, errors.New("无法确认 Docker 端口映射")
	}
	raw := mustGet(section, key)
	if raw == nil {
		return nil, nil
	}
	bindings, ok := asRecord(raw)
	if !ok {
		return nil, errors.New("Docker 端口映射无效")
	}
	var ports []contract.DockerPublishedPort
	for _, key := range bindings.orderedKeys() {
		port, protocol, err := parsePortKey(key)
		if err != nil {
			return nil, err
		}
		raw := mustGet(bindings, key)
		if raw == nil {
			continue
		}
		rows, ok := asArray(raw)
		if !ok {
			return nil, errors.New("Docker 端口映射无效")
		}
		for _, row := range rows {
			binding, ok := asRecord(row)
			if !ok {
				return nil, errors.New("Docker 端口映射无效")
			}
			ip, ipOK := asString(mustGet(binding, "HostIp"))
			rawPort, portOK := asString(mustGet(binding, "HostPort"))
			if configured && portOK && (rawPort == "" || rawPort == "0") {
				continue // Docker chooses this port at start.
			}
			hostPort, err := strconv.Atoi(rawPort)
			addr, ipErr := netip.ParseAddr(ip)
			if !ipOK || (!configured || ip != "") && ipErr != nil || err != nil || hostPort < 1 || hostPort > 65535 {
				return nil, errors.New("Docker 宿主机端口绑定无效")
			}
			if ipErr == nil {
				ip = addr.String()
			}
			ports = append(ports, contract.DockerPublishedPort{ContainerID: id,
				HostIP: ip, HostPort: hostPort, ContainerPort: port, Protocol: protocol})
		}
	}
	return ports, nil
}

// ReadContainerFirewallInventory includes stopped containers. On the routine
// check only IDs are needed. Inspect bindings before releasing an orphaned rule.
func ReadContainerFirewallInventory(ctx context.Context, engine seam.DockerTransport, withBindings bool) (map[string]bool, []contract.DockerPublishedPort, error) {
	if engine == nil {
		return nil, nil, errors.New("Docker Engine 未装配")
	}
	reply, err := engine.Request(ctx, seam.EngineRequest{Method: http.MethodGet, Path: "/containers/json",
		Query: url.Values{"all": {"1"}}, Timeout: listTimeout, MaxBytes: jsonMaxBytes})
	if err != nil || reply.Status != http.StatusOK {
		return nil, nil, errors.New("无法确认完整 Docker 容器清单")
	}
	var rows []struct {
		ID string `json:"Id"`
	}
	if json.Unmarshal(reply.Body, &rows) != nil || rows == nil || assertListLimit(len(rows), "Docker 容器") != nil {
		return nil, nil, errors.New("Docker 容器清单无效")
	}
	ids := make(map[string]bool, len(rows))
	var ports []contract.DockerPublishedPort
	for _, row := range rows {
		if !agentOperationIDPattern.MatchString(row.ID) || ids[row.ID] {
			return nil, nil, errors.New("Docker 容器清单身份无效")
		}
		ids[row.ID] = true
		if !withBindings {
			continue
		}
		s := dockerService{deps: serviceDeps{transport: engine}}
		inspect, err := s.inspectContainerByID(ctx, row.ID, actionTimeout)
		if err != nil {
			return nil, nil, err
		}
		configured, err := inspectPortBindings(row.ID, inspect, true)
		if err != nil {
			return nil, nil, err
		}
		live, err := inspectPortBindings(row.ID, inspect, false)
		if err != nil {
			return nil, nil, err
		}
		ports = append(ports, configured...)
		ports = append(ports, live...)
	}
	return ids, ports, nil
}

// ReadPublishedPorts uses the live list endpoint so that a daemon which
// recovers after panel startup can supply current bindings immediately.
func ReadPublishedPorts(ctx context.Context, engine seam.DockerTransport) ([]contract.DockerPublishedPort, error) {
	if engine == nil {
		return nil, errors.New("Docker Engine 未装配")
	}
	reply, err := engine.Request(ctx, seam.EngineRequest{
		Method: http.MethodGet, Path: "/containers/json", Timeout: listTimeout, MaxBytes: jsonMaxBytes,
	})
	if err != nil || reply.Status != http.StatusOK {
		return nil, errors.New("Docker Engine 无法返回容器清单")
	}
	var containers []struct {
		ID    string `json:"Id"`
		Names []string
		Ports []struct {
			IP          string
			PublicPort  int
			PrivatePort int
			Type        string
		}
	}
	if err := json.Unmarshal(reply.Body, &containers); err != nil || containers == nil {
		return nil, errors.New("Docker 发布端口响应无效")
	}
	if err := assertListLimit(len(containers), "Docker 容器"); err != nil {
		return nil, err
	}
	ports := make([]contract.DockerPublishedPort, 0)
	seen := make(map[contract.DockerPublishedPort]bool)
	for _, container := range containers {
		name := container.ID
		if len(container.Names) > 0 {
			name = strings.TrimPrefix(container.Names[0], "/")
		}
		for _, binding := range container.Ports {
			if binding.PublicPort == 0 {
				continue
			}
			addr, err := netip.ParseAddr(binding.IP)
			if err != nil || container.ID == "" || name == "" || binding.PublicPort < 1 || binding.PublicPort > 65535 ||
				binding.PrivatePort < 1 || binding.PrivatePort > 65535 || binding.Type == "" {
				return nil, errors.New("Docker 返回了无效的宿主机端口绑定")
			}
			port := contract.DockerPublishedPort{ContainerID: container.ID, ContainerName: name,
				HostIP: addr.String(), HostPort: binding.PublicPort, ContainerPort: binding.PrivatePort, Protocol: binding.Type}
			if !seen[port] {
				seen[port] = true
				ports = append(ports, port)
			}
		}
	}
	slices.SortFunc(ports, func(a, b contract.DockerPublishedPort) int {
		if c := a.HostPort - b.HostPort; c != 0 {
			return c
		}
		if c := strings.Compare(a.Protocol, b.Protocol); c != 0 {
			return c
		}
		if c := strings.Compare(a.HostIP, b.HostIP); c != 0 {
			return c
		}
		if c := strings.Compare(a.ContainerID, b.ContainerID); c != 0 {
			return c
		}
		return a.ContainerPort - b.ContainerPort
	})
	return ports, nil
}
