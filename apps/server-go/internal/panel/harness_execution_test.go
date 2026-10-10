package panel

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMaintenanceWithoutConfiguredExecutionDoesNotRequireDocker(t *testing.T) {
	h := SystemHost{Store: Store{Root: t.TempDir()}, DockerSocket: filepath.Join(t.TempDir(), "absent.sock")}
	if err := h.recoverAgentExecution(context.Background()); err != nil {
		t.Fatalf("普通安装不应被新增 Docker 依赖阻止维护：%v", err)
	}
	writeRestoreFixture(t, h.Store.Root, "config/agent-mcp-servers.json", `{"version":1,"servers":[{"transport":"streamable-http"}],"catalogs":[]}`)
	if err := h.recoverAgentExecution(context.Background()); err != nil {
		t.Fatalf("仅 HTTP MCP 不应要求 Docker：%v", err)
	}
}

func TestMaintenanceRequiresDockerForConfiguredOrPendingExecution(t *testing.T) {
	for _, kind := range []string{"执行配置", "stdio配置", "未决屏障", "配置损坏"} {
		t.Run(kind, func(t *testing.T) {
			h := SystemHost{Store: Store{Root: t.TempDir()}, DockerSocket: filepath.Join(t.TempDir(), "absent.sock")}
			switch kind {
			case "执行配置":
				writeRestoreFixture(t, h.Store.Root, "config/agent-execution.json", `{"schema":1,"profiles":[{"enabled":false}],"grants":[]}`)
			case "stdio配置":
				writeRestoreFixture(t, h.Store.Root, "config/agent-mcp-servers.json", `{"version":1,"servers":[{"transport":"container-stdio","active":false}],"catalogs":[]}`)
			case "未决屏障":
				createRestoreDatabase(t, h.Store.Root, "PRAGMA user_version=3", "CREATE TABLE execution_barriers(state TEXT NOT NULL)", "INSERT INTO execution_barriers VALUES('unknown')")
			case "配置损坏":
				writeRestoreFixture(t, h.Store.Root, "config/agent-execution.json", "损坏配置")
			}
			if err := h.recoverAgentExecution(context.Background()); err == nil {
				t.Fatal("存在执行历史且无法确认容器停止时必须阻止维护")
			}
		})
	}
}

func TestMaintenanceChecksOwnedContainersAndVolumesAfterStop(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "已确认停止", true: "引擎不可用"}[fail], func(t *testing.T) {
			socket := filepath.Join(t.TempDir(), "docker.sock")
			listener, err := net.Listen("unix", socket)
			if err != nil {
				t.Fatal(err)
			}
			var containers, volumes atomic.Int32
			server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Query().Get("filters"), "elysian.agent.execution=true") {
					t.Error("恢复扫描必须只查询受管执行对象")
				}
				if fail {
					w.WriteHeader(503)
					return
				}
				switch r.URL.Path {
				case "/v1.41/containers/json":
					containers.Add(1)
					w.Write([]byte(`[]`))
				case "/v1.41/volumes":
					volumes.Add(1)
					w.Write([]byte(`{"Volumes":[]}`))
				default:
					t.Errorf("不应操作无关 Docker 资源：%s", r.URL.Path)
					w.WriteHeader(404)
				}
			})}
			go server.Serve(listener)
			defer server.Close()
			h := SystemHost{Store: Store{Root: t.TempDir()}, DockerSocket: socket}
			err = h.recoverAgentExecution(context.Background())
			if fail && err == nil || !fail && err != nil {
				t.Fatalf("停止核实结果错误：%v", err)
			}
			if !fail && (containers.Load() != 1 || volumes.Load() != 1) {
				t.Fatal("停服后的容器与卷都必须核实")
			}
		})
	}
}
