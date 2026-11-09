package panel

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/config"
)

func installPreflightFixture(t *testing.T) (SystemHost, config.PanelNetwork) {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{"systemctl": "printf '0\\n'", "ss": "exit 0", "ufw": "exit 0"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	a, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	ports := config.PanelNetwork{FrontendPort: a.Addr().(*net.TCPAddr).Port, BackendPort: b.Addr().(*net.TCPAddr).Port}
	return SystemHost{Store: Store{Root: t.TempDir()}, DockerSocket: filepath.Join(dir, "docker.sock"), MissingServiceOK: true}, ports
}

func TestInstallPreflightDefersStaleDockerSocketOnlyBeforeDependencies(t *testing.T) {
	host, ports := installPreflightFixture(t)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: host.DockerSocket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	listener.Close()
	host.BeforePlatformDependencies = true
	if err := CheckInstall(context.Background(), host.Store, host, ports); err != nil {
		t.Fatalf("依赖准备前不应访问尚未就绪的 Docker：%v", err)
	}
	host.BeforePlatformDependencies = false
	if err := CheckInstall(context.Background(), host.Store, host, ports); err == nil || !strings.Contains(err.Error(), "无法核对 Docker 端口") {
		t.Fatalf("完整安装预检必须保留 Docker 不可达错误：%v", err)
	}
}

func TestInstallPreflightStillRejectsStoppedContainerPortReservations(t *testing.T) {
	host, ports := installPreflightFixture(t)
	listener, err := net.Listen("unix", host.DockerSocket)
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if strings.HasSuffix(r.URL.Path, "/containers/json") {
			json.NewEncoder(w).Encode([]map[string]any{{"Id": "stopped", "Ports": []any{}}})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"HostConfig": map[string]any{"PortBindings": map[string]any{"80/tcp": []map[string]any{{"HostPort": strconv.Itoa(ports.FrontendPort)}}}}})
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	host.BeforePlatformDependencies = true
	if err := host.Preflight(context.Background(), ports, ports); err != nil || requests.Load() != 0 {
		t.Fatalf("依赖准备前不得读取 Docker：%v, %d", err, requests.Load())
	}
	host.BeforePlatformDependencies = false
	if err := host.Preflight(context.Background(), ports, ports); err == nil || !strings.Contains(err.Error(), "已由容器预留") {
		t.Fatalf("Docker 就绪后必须检查停止容器的端口预留：%v", err)
	}
}

func TestBeforeDependenciesStillBlocksMaintenanceAndLocalReservations(t *testing.T) {
	for _, state := range []string{"queued", "recovery-failed"} {
		t.Run(state, func(t *testing.T) {
			host, ports := installPreflightFixture(t)
			host.BeforePlatformDependencies = true
			record := taskRecord{Task: Task{ID: strings.Repeat("a", 32), Kind: "update", State: state, OldPorts: ports, NewPorts: ports}}
			if err := host.Store.save(record); err != nil {
				t.Fatal(err)
			}
			if err := CheckInstall(context.Background(), host.Store, host, ports); err == nil || !strings.Contains(err.Error(), "维护任务尚未结束") {
				t.Fatalf("依赖准备前仍须拒绝未完成维护：%v", err)
			}
		})
	}
	t.Run("website-port", func(t *testing.T) {
		host, ports := installPreflightFixture(t)
		host.BeforePlatformDependencies = true
		if err := config.AtomicJSON(filepath.Join(host.Store.Root, "config", "websites.json"), []map[string]int{{"port": ports.FrontendPort}}); err != nil {
			t.Fatal(err)
		}
		if err := CheckInstall(context.Background(), host.Store, host, ports); err == nil || !strings.Contains(err.Error(), "已由网站项目保留") {
			t.Fatalf("依赖准备前仍须核对登记端口：%v", err)
		}
	})
}
