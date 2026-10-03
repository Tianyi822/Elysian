package panel

import (
	"context"
	"elysian/server/internal/config"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type SystemHost struct {
	Store            Store
	DockerSocket     string
	MissingServiceOK bool
}

func (h SystemHost) Available() bool {
	_, err := os.Stat("/run/systemd/system")
	st, e := os.Stat(filepath.Join(InstallRoot, "maintenance", "elysian"))
	return os.Geteuid() == 0 && err == nil && e == nil && st.Mode().IsRegular() && st.Mode().Perm()&0100 != 0
}

type logWriter struct {
	store Store
	id    string
}

func (w logWriter) Write(b []byte) (int, error) {
	w.store.appendLog(w.id, string(b))
	return len(b), nil
}

func (h SystemHost) command(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	c.Env = []string{"PATH=/usr/local/go/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "HOME=/var/lib/elysian"}
	b, err := c.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s 执行失败：%s %w", name, strings.TrimSpace(string(b)), err)
	}
	return string(b), nil
}

func (h SystemHost) Dispatch(ctx context.Context, worker, id string) error {
	_, err := h.command(ctx, "systemd-run", "--unit=elysian-maintenance-"+id, "--collect", "--property=Type=exec", "--setenv=HOME="+filepath.Dir(h.Store.Root), "--setenv=ELYSIAN_DOCKER_SOCKET="+h.DockerSocket, worker, "maintenance-worker", id)
	return err
}
func (h SystemHost) WorkerActive(ctx context.Context, id string) bool {
	_, err := h.command(ctx, "systemctl", "is-active", "--quiet", "elysian-maintenance-"+id)
	return err == nil
}
func (h SystemHost) Stop(ctx context.Context) error {
	_, err := h.command(ctx, "systemctl", "stop", ServiceName)
	return err
}
func (h SystemHost) Start(ctx context.Context) error {
	_, err := h.command(ctx, "systemctl", "start", ServiceName)
	return err
}

func (h SystemHost) Preflight(ctx context.Context, old, next config.PanelNetwork) error {
	if err := next.Validate(); err != nil {
		return err
	}
	if err := checkPanelReservations(h.Store.Root, next); err != nil {
		return err
	}
	if _, err := exec.LookPath("sshd"); err == nil {
		ssh, err := h.command(ctx, "sshd", "-T")
		if err != nil {
			return fmt.Errorf("无法核对 SSH 配置：%w", err)
		}
		for _, line := range strings.Split(ssh, "\n") {
			fields := strings.Fields(line)
			if len(fields) == 2 && fields[0] == "port" {
				port, _ := strconv.Atoi(fields[1])
				if port == next.FrontendPort || port == next.BackendPort {
					return fmt.Errorf("端口 %d 已由 SSH 配置保留", port)
				}
			}
		}
	}
	pid, err := h.command(ctx, "systemctl", "show", "--property=MainPID", "--value", ServiceName)
	if err != nil {
		if !h.MissingServiceOK {
			return err
		}
		pid = "0"
	}
	pid = strings.TrimSpace(pid)
	out, err := h.command(ctx, "ss", "-H", "-ltnp")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		address := fields[3]
		colon := strings.LastIndex(address, ":")
		if colon < 0 {
			continue
		}
		port, _ := strconv.Atoi(address[colon+1:])
		if port != next.FrontendPort && port != next.BackendPort {
			continue
		}
		own := pid != "0" && pid != "" && strings.Contains(line, "pid="+pid+",") && (port == old.FrontendPort || port == old.BackendPort)
		if !own {
			return fmt.Errorf("端口 %d 已被宿主服务占用", port)
		}
	}
	for _, port := range []int{next.FrontendPort, next.BackendPort} {
		if pid != "0" && (port == old.FrontendPort || port == old.BackendPort) {
			continue
		}
		l, err := net.Listen("tcp", ":"+strconv.Itoa(port))
		if err != nil {
			return fmt.Errorf("端口 %d 无法绑定：%w", port, err)
		}
		l.Close()
	}
	if err := h.containerPorts(ctx, next); err != nil {
		return err
	}
	rules, err := h.Rules(ctx)
	if err != nil {
		return err
	}
	return validateRules(rules, old, next)
}

func (h SystemHost) containerPorts(ctx context.Context, p config.PanelNetwork) error {
	socket := h.DockerSocket
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	if _, err := os.Stat(socket); os.IsNotExist(err) {
		return nil
	}
	t := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
	}}
	defer t.CloseIdleConnections()
	c := &http.Client{Transport: t, Timeout: 10 * time.Second}
	r, err := http.NewRequestWithContext(ctx, "GET", "http://docker/v1.41/containers/json?all=1", nil)
	if err != nil {
		return err
	}
	response, err := c.Do(r)
	if err != nil {
		return fmt.Errorf("无法核对 Docker 端口：%w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("无法核对 Docker 端口：HTTP %d", response.StatusCode)
	}
	var rows []struct {
		ID    string `json:"Id"`
		Ports []struct {
			PublicPort int `json:"PublicPort"`
		} `json:"Ports"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&rows); err != nil {
		return err
	}
	for _, row := range rows {
		for _, port := range row.Ports {
			if port.PublicPort == p.FrontendPort || port.PublicPort == p.BackendPort {
				return fmt.Errorf("端口 %d 已被容器或网站占用", port.PublicPort)
			}
		}
		// 停用容器也保留 HostConfig.PortBindings，不能只看运行中的 Ports。
		request, err := http.NewRequestWithContext(ctx, "GET", "http://docker/v1.41/containers/"+row.ID+"/json", nil)
		if err != nil {
			return err
		}
		response, err := c.Do(request)
		if err != nil {
			return fmt.Errorf("无法核对容器预留端口：%w", err)
		}
		var detail struct {
			HostConfig struct {
				PortBindings map[string][]struct {
					HostPort string `json:"HostPort"`
				} `json:"PortBindings"`
			} `json:"HostConfig"`
		}
		err = json.NewDecoder(io.LimitReader(response.Body, 8*1024*1024)).Decode(&detail)
		response.Body.Close()
		if response.StatusCode != 200 || err != nil {
			return fmt.Errorf("无法核对容器 %s 的端口配置", row.ID)
		}
		for _, bindings := range detail.HostConfig.PortBindings {
			for _, binding := range bindings {
				port, _ := strconv.Atoi(binding.HostPort)
				if port == p.FrontendPort || port == p.BackendPort {
					return fmt.Errorf("端口 %d 已由容器预留", port)
				}
			}
		}
	}
	return nil
}

func (h SystemHost) Build(ctx context.Context, source, sha, id string) (string, error) {
	stage := filepath.Dir(source)
	if _, err := h.command(ctx, "chown", "-R", "elysian-build:elysian-build", stage); err != nil {
		return "", err
	}
	output := filepath.Join(stage, "artifact")
	c := exec.CommandContext(ctx, "runuser", "-u", "elysian-build", "--", "env", "HOME="+stage, "PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin", "bash", filepath.Join(InstallRoot, "maintenance", "build-release.sh"), source, output, sha)
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	c.Cancel = func() error { return syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
	c.WaitDelay = 2 * time.Second
	c.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"}
	c.Stdout = logWriter{h.Store, id}
	c.Stderr = c.Stdout
	if err := c.Run(); err != nil {
		return "", fmt.Errorf("源码构建失败：%w（详见任务日志）", err)
	}
	release := filepath.Join(InstallRoot, "releases", sha+"-"+id)
	if err := os.MkdirAll(release, 0755); err != nil {
		return "", err
	}
	binary := filepath.Join(release, "elysian")
	if err := copyRegular(filepath.Join(output, "elysian"), binary, 0755); err != nil {
		return "", err
	}
	return binary, nil
}

func (h SystemHost) Healthy(ctx context.Context, ports config.PanelNetwork, commit string) error {
	deadline := time.NewTimer(60 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		good := true
		for _, port := range []int{ports.BackendPort, ports.FrontendPort} {
			r, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/api/health", port), nil)
			if err != nil {
				return err
			}
			response, err := client.Do(r)
			if err != nil {
				good = false
				break
			}
			var health struct {
				OK     bool                `json:"ok"`
				Commit string              `json:"commit"`
				Ports  config.PanelNetwork `json:"ports"`
			}
			err = json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&health)
			response.Body.Close()
			if err != nil || response.StatusCode != 200 || !health.OK || health.Ports != ports || (commit != "" && health.Commit != commit) {
				good = false
				break
			}
		}
		if good {
			r, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d/", ports.FrontendPort), nil)
			if err != nil {
				return err
			}
			response, err := client.Do(r)
			if err == nil {
				b, e := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
				response.Body.Close()
				if e == nil && response.StatusCode == 200 && strings.Contains(string(b), "<title>Elysian</title>") && healthyAssets(ctx, client, ports.FrontendPort, string(b)) {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("重启后健康检查超时（60 秒）")
		case <-ticker.C:
		}
	}
}

var assetPath = regexp.MustCompile(`(?:src|href)="(/assets/[^"<>]+)"`)

func healthyAssets(ctx context.Context, client *http.Client, port int, html string) bool {
	matches := assetPath.FindAllStringSubmatch(html, 32)
	if len(matches) == 0 {
		return false
	}
	for _, match := range matches {
		request, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("http://127.0.0.1:%d%s", port, match[1]), nil)
		if err != nil {
			return false
		}
		response, err := client.Do(request)
		if err != nil {
			return false
		}
		b, err := io.ReadAll(io.LimitReader(response.Body, 1))
		response.Body.Close()
		if err != nil || len(b) == 0 || response.StatusCode != 200 || strings.Contains(response.Header.Get("Content-Type"), "text/html") {
			return false
		}
	}
	return true
}

func copyRegular(source, destination string, mode os.FileMode) error {
	st, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("构建产物或备份不是普通文件")
	}
	in, err := os.OpenFile(source, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	e := out.Close()
	if err == nil {
		err = e
	}
	return err
}
