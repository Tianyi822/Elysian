package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"slices"
	"strings"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

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
