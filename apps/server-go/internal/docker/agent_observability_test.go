package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAgentDetailOnlyProjectsSelectedFields(t *testing.T) {
	inspect := hostScopeInspect(hostScopeID, map[string]string{
		"com.docker.compose.project": "edge", "com.docker.compose.project.working_dir": "/secret-dir",
	}, func(row map[string]any) {
		row["Path"] = "/usr/bin/server"
		row["Args"] = []string{"--secret", "argv-secret"}
		row["Config"].(map[string]any)["Env"] = []string{"TOKEN=env-secret", "TZ=Asia/Shanghai"}
		row["Mounts"] = []map[string]any{{"Type": "bind", "Source": "/srv/frp", "Destination": "/config", "RW": false}}
		row["State"].(map[string]any)["Health"] = map[string]any{"Status": "healthy", "Log": "health-secret"}
	})
	engine := newFakeEngine(nil)
	readOnly(engine, inspect)
	facade := facadeWithEngine(t, engine)
	container, detail, err := facade.InspectHostContainer(t.Context(), hostScopeID, true)
	raw, _ := json.Marshal(detail)
	if err != nil || container.ID != hostScopeID || detail.Program != "server" || detail.ArgumentCount != 2 ||
		detail.Health != "healthy" || detail.Ownership != "user" || len(detail.Mounts) != 1 || detail.Mounts[0].Source != "/srv/frp" ||
		strings.Join(detail.EnvKeys, ",") != "TOKEN,TZ" || !strings.Contains(string(raw), "edge") || strings.Contains(string(raw), "secret") {
		t.Fatalf("unexpected inspect projection: %s, %v", raw, err)
	}
}

func TestAgentObservationRejectsWrongIdentityAndUnidentifiedPanel(t *testing.T) {
	engine := newFakeEngine(nil)
	readOnly(engine, hostScopeInspect(strings.Repeat("d", 64), nil, nil))
	facade := facadeWithEngine(t, engine)
	for _, read := range []func() error{
		func() error { _, _, err := facade.InspectHostContainer(t.Context(), hostScopeID, true); return err },
		func() error { _, err := facade.ContainerStats(t.Context(), hostScopeID); return err },
		func() error { _, err := facade.Logs(t.Context(), hostScopeID, 0); return err },
		func() error { _, err := facade.DescribeContainer(t.Context(), hostScopeID); return err },
	} {
		if err := read(); err == nil || !strings.Contains(err.Error(), "ID 不匹配") {
			t.Fatalf("mismatched inspect identity accepted: %v", err)
		}
	}
	facade.service.deps.selfContainerID = ""
	facade.service.deps.panelRuntime = classifyPanelRuntime(false, "0::/system.slice/docker-example.scope")
	count := len(engine.Requests())
	if _, err := facade.ContainerStats(t.Context(), hostScopeID); err == nil || !strings.Contains(err.Error(), "面板自身容器身份未确认") || len(engine.Requests()) != count {
		t.Fatalf("unidentified panel should reject before accessing Engine: %v", err)
	}
	if classifyPanelRuntime(false, "0::/system.slice/elysian.service") != "host" || classifyPanelRuntime(true, "0::/") != "unknown" {
		t.Fatal("panel runtime evidence did not distinguish bare metal and container")
	}
}

func TestAgentContainerStatsUsesTwoSamplesAndDistinguishesZeroFromMissing(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch call.Path {
		case "/containers/" + hostScopeID + "/json":
			return 200, hostScopeInspect(hostScopeID, nil, nil), true
		case "/containers/" + hostScopeID + "/stats":
			if call.Query.Get("stream") != "false" || call.Query.Has("one-shot") || call.Method != http.MethodGet {
				t.Errorf("unexpected stats request: %+v", call)
			}
			return 200, `{"cpu_stats":{"cpu_usage":{"total_usage":125},"system_cpu_usage":200,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":100},"memory_stats":{"usage":12582912,"limit":16777216,"stats":{"inactive_file":4194304}},"pids_stats":{"current":0},"networks":{"eth0":{"rx_bytes":0},"eth1":{"rx_bytes":9}},"blkio_stats":{"io_service_bytes_recursive":[{"op":"Read","value":7},{"op":"read","value":5},{"op":"Total","value":22}]}}`, true
		default:
			return 0, "", false
		}
	})
	facade := facadeWithEngine(t, engine)
	value, err := facade.ContainerStats(t.Context(), hostScopeID)
	stats, ok := value.(agentContainerStats)
	if err != nil || !ok || stats.CPUPercent == nil || *stats.CPUPercent != 50 || stats.MemoryMiB == nil || *stats.MemoryMiB != 8 ||
		stats.PIDs == nil || *stats.PIDs != 0 || stats.PIDsLimit != nil || stats.NetworkRxBytes == nil || *stats.NetworkRxBytes != 9 ||
		stats.NetworkTxBytes != nil || stats.BlockReadBytes == nil || *stats.BlockReadBytes != 12 || stats.BlockWriteBytes != nil {
		t.Fatalf("unexpected stats: %+v %v", stats, err)
	}
	stopped := newFakeEngine(func(call engineCall) (int, string, bool) {
		if !strings.HasSuffix(call.Path, "/json") {
			t.Errorf("stats requested for stopped container: %s", call.Path)
			return 0, "", false
		}
		return 200, hostScopeInspect(hostScopeID, nil, func(row map[string]any) {
			row["State"] = map[string]any{"Status": "exited", "Running": false}
		}), true
	})
	value, err = facadeWithEngine(t, stopped).ContainerStats(t.Context(), hostScopeID)
	if stats, ok := value.(agentContainerStats); err != nil || !ok || stats.Status != "exited" || stats.CPUPercent != nil {
		t.Fatalf("unexpected stopped stats: %+v %v", value, err)
	}
}

func TestAgentInventoryJoinsStoppedContainersAndOmitsPrivateFields(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch call.Path {
		case "/networks":
			return 200, `[{"Id":"net","Name":"edge","Driver":"bridge","Scope":"local","IPAM":{"Config":[{"Subnet":"10.0.0.0/24","Gateway":"10.0.0.1"}]}},{"Id":"net2","Name":"zzz"}]`, true
		case "/volumes":
			return 200, `{"Volumes":[{"Name":"config","Driver":"local","Mountpoint":"/hidden-placement","Options":{"password":"secret"},"Labels":{"com.docker.compose.project":"edge"}}]}`, true
		case "/containers/json":
			if call.Query.Get("all") != "1" {
				t.Error("container lookup omitted stopped containers")
			}
			return 200, `[{"Id":"` + hostScopeID + `","Names":["/frp"],"State":"exited","NetworkSettings":{"Networks":{"edge":{"NetworkID":"net"}}},"Mounts":[{"Type":"volume","Name":"config"}]},{"Id":"` + strings.Repeat("a", 64) + `","Names":["/internal"],"Labels":{"elysian.agent.execution":"true"},"Mounts":[{"Type":"volume","Name":"config"}]}]`, true
		default:
			return 0, "", false
		}
	})
	facade := facadeWithEngine(t, engine)
	networks, err := facade.NetworkInventory(context.Background(), 1)
	network := networks.(agentInventory[agentNetwork])
	if err != nil || !network.Truncated || len(network.Items) != 1 || len(network.Items[0].Containers) != 1 ||
		network.Items[0].Containers[0].ID != hostScopeID || len(network.Items[0].Subnets) != 1 {
		t.Fatalf("unexpected networks: %+v %v", network, err)
	}
	volumes, err := facade.VolumeInventory(context.Background(), 1)
	volume := volumes.(agentInventory[agentVolume])
	raw, _ := json.Marshal(volume)
	if err != nil || volume.Truncated || len(volume.Items) != 1 || len(volume.Items[0].UsedBy) != 1 || volume.Items[0].UsedBy[0].Name != "frp" ||
		strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "hidden-placement") {
		t.Fatalf("unexpected volumes: %s %v", raw, err)
	}
}
