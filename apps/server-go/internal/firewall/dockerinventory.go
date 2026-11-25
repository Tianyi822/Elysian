package firewall

import (
	"context"
	"strings"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/contract"
)

type dockerPortsResponse struct {
	Inventory string                         `json:"inventory"`
	Ports     []contract.DockerPublishedPort `json:"ports"`
	Guard     dockerGuardStatus              `json:"guard"`
}

type dockerGuardStatus struct {
	State          string `json:"state"`
	KernelVerified bool   `json:"kernelVerified"`
}

func (deps Deps) dockerPorts(ctx context.Context) dockerPortsResponse {
	guard := make(chan dockerGuardStatus, 1)
	go func() {
		if deps.Mode != config.ModeBareMetal {
			guard <- dockerGuardStatus{State: "unsupported"}
			return
		}
		ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
		defer cancel()
		guard <- newDockerFirewall().guardStatus(ctx)
	}()
	result := dockerPortsResponse{Inventory: "unavailable", Ports: []contract.DockerPublishedPort{}}
	if deps.PublishedPorts != nil {
		if ports, err := deps.PublishedPorts(ctx); err == nil {
			result.Inventory = "ready"
			if ports != nil {
				result.Ports = ports
			}
		}
	}
	result.Guard = <-guard
	return result
}

func (d *dockerFirewall) guardStatus(ctx context.Context) dockerGuardStatus {
	raw, err := d.run(ctx, "", "ufw", "status", "verbose")
	if err != nil {
		return dockerGuardStatus{State: "unknown"}
	}
	status, err := parseStatusVerbose(raw)
	if err != nil {
		return dockerGuardStatus{State: "unknown"}
	}
	if !status.Active {
		return dockerGuardStatus{State: "disabled"}
	}
	result := dockerGuardStatus{State: "degraded"}
	conf, err := d.read(defaultFirewallPaths.UfwConf)
	if err != nil || ufwSetting(string(conf), "ENABLED") != "yes" {
		return result
	}
	plans, err := d.dockerPlans(ctx, false, false, false)
	if err != nil || len(plans) != 0 {
		return result
	}
	result.KernelVerified = true
	owned, err := dockerFirewallInstalled()
	if err != nil || !owned {
		return result
	}
	// On v1 (including the production recovery drop-in), the original unit
	// still runs the watcher. For v2 the compatibility unit only runs sync.
	unit := dockerFirewallService
	if installed, err := ownedSystemdFile(dockerWatchFile, dockerWatchUnit); err == nil && installed {
		unit = dockerWatchService
	} else if err != nil {
		return result
	}
	if out, err := d.run(ctx, "", "systemctl", "is-active", unit); err == nil && strings.TrimSpace(out) == "active" {
		result.State = "verified"
	}
	return result
}
