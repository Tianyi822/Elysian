package firewall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"elysian/server/internal/atomicfile"
)

const dockerFirewallUnit = `[Unit]
Description=Elysian UFW policy for Docker published ports
After=ufw.service
Before=docker.service

[Service]
Type=simple
ExecStartPre=/opt/elysian/docker-firewall/elysian docker-firewall-sync
ExecStart=/opt/elysian/docker-firewall/elysian docker-firewall-watch
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
RequiredBy=docker.service
`

func dockerFirewallInstalled() (bool, error) {
	info, err := os.Lstat(dockerFirewallRoot)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0o700 || stat.Uid != 0 {
		return false, fmt.Errorf("Docker 防火墙目录归属无法确认：%s", dockerFirewallRoot)
	}
	unitPath := filepath.Join(dockerFirewallRoot, dockerFirewallService)
	root := uint32(0)
	file, err := atomicfile.OpenTrusted(unitPath, atomicfile.TrustOptions{
		OwnerUID: &root, RejectPerm: 0o022, MaxBytes: 4096, SingleLink: true,
	})
	if err != nil {
		return false, err
	}
	defer file.Close()
	unit, err := io.ReadAll(file)
	if err != nil || string(unit) != dockerFirewallUnit {
		return false, fmt.Errorf("Docker 防火墙单元归属无法确认：%s", unitPath)
	}
	return true, nil
}

// StartDockerFirewall is reached by the candidate binary, including when the
// update worker belongs to the previous version and never runs install.sh.
func StartDockerFirewall(ctx context.Context, socket string) error {
	ctx, cancel := context.WithTimeout(ctx, dockerFirewallTimeout)
	defer cancel()
	d := newDockerFirewall()
	owned, err := dockerFirewallInstalled()
	if err != nil {
		return err
	}
	if !owned {
		// The release smoke test and unmanaged bare-metal processes have no
		// systemd. A real installation must be able to keep the policy alive.
		if _, err := os.Stat("/run/systemd/system"); errors.Is(err, os.ErrNotExist) {
			if _, socketErr := os.Stat(socket); errors.Is(socketErr, os.ErrNotExist) {
				return nil
			}
			return errors.New("Docker 防火墙需要正式裸机部署的 systemd")
		} else if err != nil {
			return err
		}
	}
	if err := d.checkDockerSetup(ctx, socket); err != nil {
		return err
	}
	if owned {
		unit := filepath.Join(dockerFirewallRoot, dockerFirewallService)
		if _, err := d.run(ctx, "", "systemctl", "enable", "--now", unit); err != nil {
			return err
		}
		return withDockerFirewallLock(ctx, func() error { return d.reconcile(ctx, false) })
	}
	if err := withDockerFirewallLock(ctx, func() error {
		if err := d.testDockerPlans(ctx, true); err != nil {
			return err
		}
		return stageDockerFirewall()
	}); err != nil {
		return err
	}
	unit := filepath.Join(dockerFirewallRoot, dockerFirewallService)
	if _, err := d.run(ctx, "", "systemctl", "enable", "--now", unit); err != nil {
		recoverCtx, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
		defer cancel()
		return errors.Join(err, RemoveDockerFirewall(recoverCtx))
	}
	return nil
}

// CheckDockerFirewall is the read-only candidate preflight used before the
// installer or an upgraded online worker takes down the current panel.
func CheckDockerFirewall(ctx context.Context, socket string) error {
	d := newDockerFirewall()
	if err := d.checkDockerSetup(ctx, socket); err != nil {
		return err
	}
	owned, err := dockerFirewallInstalled()
	if err != nil {
		return err
	}
	return withDockerFirewallLock(ctx, func() error { return d.testDockerPlans(ctx, !owned) })
}

func (d *dockerFirewall) testDockerPlans(ctx context.Context, first bool) error {
	plans, err := d.dockerPlans(ctx, first, false, false)
	if err != nil {
		return err
	}
	for _, plan := range plans {
		if _, err := d.run(ctx, plan.batch, plan.binary+"-restore", "-w", "5", "--noflush", "--test"); err != nil {
			return fmt.Errorf("Docker 防火墙接管预检失败：%w", err)
		}
	}
	return nil
}

func stageDockerFirewall() error {
	linked, err := dockerFirewallUnitLinked()
	if err != nil || linked {
		return errors.Join(err, errors.New("已存在 Docker 防火墙系统单元"))
	}
	parent := filepath.Dir(dockerFirewallRoot)
	dir, err := os.MkdirTemp(parent, ".docker-firewall-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	source, err := os.Open(binary)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(filepath.Join(dir, "elysian"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	if err := target.Chmod(0o700); err != nil {
		_ = target.Close()
		return err
	}
	_, copyErr := io.Copy(target, source)
	if err := errors.Join(copyErr, target.Sync(), target.Close()); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(dir, dockerFirewallService), []byte(dockerFirewallUnit),
		atomicfile.WriteOptions{DirSync: true}); err != nil {
		return err
	}
	if err := os.Rename(dir, dockerFirewallRoot); err != nil {
		return err
	}
	return atomicfile.SyncDirectory(parent)
}

func dockerFirewallUnitLinked() (bool, error) {
	unit := filepath.Join(dockerFirewallRoot, dockerFirewallService)
	primary := filepath.Join("/etc/systemd/system", dockerFirewallService)
	linked := false
	for _, parent := range []string{"/etc/systemd/system", "/etc/systemd/system/docker.service.requires", "/etc/systemd/system/multi-user.target.wants"} {
		link := filepath.Join(parent, dockerFirewallService)
		target, err := os.Readlink(link)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(parent, target)
		}
		target = filepath.Clean(target)
		if err != nil || (target != unit && (link == primary || target != primary)) {
			return false, fmt.Errorf("Docker 防火墙 systemd 链接归属无法确认：%s", link)
		}
		linked = true
	}
	return linked, nil
}

// RemoveDockerFirewall removes only the dedicated unit and tagged kernel rules.
// Unlink the dependency and reload systemd before stopping the unit so that a
// Docker daemon retained by the uninstaller stays up.
func RemoveDockerFirewall(ctx context.Context) error {
	owned, err := dockerFirewallInstalled()
	if err != nil || !owned {
		return err
	}
	d := newDockerFirewall()
	unit := filepath.Join(dockerFirewallRoot, dockerFirewallService)
	linked, err := dockerFirewallUnitLinked()
	if err != nil {
		return err
	}
	if linked {
		if _, err := d.run(ctx, "", "systemctl", "disable", dockerFirewallService); err != nil {
			return err
		}
	}
	// disable can remove the primary link. Stopping by the name of an
	// unloaded unit after that is unnecessary.
	state, err := d.run(ctx, "", "systemctl", "show", "--property=ActiveState", "--value", dockerFirewallService)
	if err != nil {
		return err
	}
	if strings.TrimSpace(state) != "inactive" {
		if _, err := d.run(ctx, "", "systemctl", "stop", dockerFirewallService); err != nil {
			return err
		}
	}
	return withDockerFirewallLock(ctx, func() error {
		if err := d.reconcile(ctx, true); err != nil {
			return err
		}
		for _, file := range []string{filepath.Join(dockerFirewallRoot, "elysian"), unit} {
			if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		return os.Remove(dockerFirewallRoot)
	})
}

// RunDockerFirewall runs inside the stable systemd installation. A short poll
// covers bare ufw commands, atomic file replacements and kernel-chain drift.
func RunDockerFirewall(ctx context.Context, watch bool, warnings io.Writer) error {
	owned, err := dockerFirewallInstalled()
	if err != nil || !owned {
		return errors.Join(err, errors.New("Docker 防火墙管理组件未安装"))
	}
	d := newDockerFirewall()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	lastError := ""
	for {
		deadline, cancel := context.WithTimeout(ctx, dockerFirewallTimeout)
		err := withDockerFirewallLock(deadline, func() error { return d.reconcile(deadline, false) })
		cancel()
		if !watch {
			return err
		}
		if err != nil && err.Error() != lastError && ctx.Err() == nil {
			fmt.Fprintf(warnings, "Docker 防火墙同步失败：%v\n", err)
			lastError = err.Error()
		}
		if err == nil && lastError != "" {
			fmt.Fprintln(warnings, "Docker 防火墙同步已恢复")
			lastError = ""
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

type dockerDaemonFirewall struct {
	Backend         string                       `json:"firewall-backend"`
	IPTables        *bool                        `json:"iptables"`
	IP6Tables       *bool                        `json:"ip6tables"`
	Direct          bool                         `json:"allow-direct-routing"`
	NetworkDefaults map[string]map[string]string `json:"default-network-opts"`
}

func checkDockerNetworkOptions(options map[string]string) error {
	const bridge = "com.docker.network.bridge."
	for _, key := range []string{"gateway_mode_ipv4", "gateway_mode_ipv6"} {
		mode := options[bridge+key]
		if mode != "" && mode != "nat" && mode != "isolated" {
			return fmt.Errorf("Docker bridge 网关模式 %q 需单独接入防火墙", mode)
		}
	}
	if options[bridge+"trusted_host_interfaces"] != "" {
		return errors.New("Docker bridge 已配置直接路由接口")
	}
	return nil
}

func (d *dockerFirewall) checkDockerSetup(ctx context.Context, socket string) error {
	for _, file := range []string{"/etc/ufw/after.rules", "/etc/ufw/after6.rules"} {
		content, err := d.read(file)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if strings.Contains(string(content), "# BEGIN UFW AND DOCKER") {
			return fmt.Errorf("%s 已由 ufw-docker 管理，需先核对并迁移已有转发授权", file)
		}
	}
	if err := d.checkDockerDaemonConfig(ctx); err != nil {
		return err
	}
	nat := make(map[string]string)
	for _, binary := range d.families() {
		raw, err := d.run(ctx, "", binary, "-w", "5", "-t", "nat", "-S")
		if err != nil {
			return err
		}
		if err := checkDockerNAT(raw); err != nil {
			return fmt.Errorf("%s：%w", binary, err)
		}
		nat[binary] = raw
	}
	info, err := os.Stat(socket)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return errors.Join(err, errors.New("无法确认 Docker Engine 的本机 Unix socket"))
	}
	docker := func(args ...string) (string, error) {
		return d.run(ctx, "", "docker", append([]string{"--host", "unix://" + socket}, args...)...)
	}
	raw, err := docker("info", "--format", "{{json .}}")
	if err != nil {
		return err
	}
	var details struct {
		FirewallBackend struct{ Driver string }
		Swarm           struct{ LocalNodeState string }
		SecurityOptions []string
	}
	if err := json.Unmarshal([]byte(raw), &details); err != nil {
		return err
	}
	if backend := details.FirewallBackend.Driver; backend != "" && backend != "iptables" {
		return fmt.Errorf("Docker 防火墙后端 %q 需单独接入 UFW", backend)
	}
	if state := details.Swarm.LocalNodeState; state != "" && state != "inactive" {
		return fmt.Errorf("Docker Swarm 状态 %q 需单独接入防火墙", state)
	}
	for _, option := range details.SecurityOptions {
		if strings.Contains(option, "name=rootless") {
			return errors.New("Rootless Docker 需单独接入防火墙")
		}
	}
	list, err := docker("network", "ls", "--quiet", "--filter", "driver=bridge")
	if err != nil {
		return err
	}
	if networks := strings.Fields(list); len(networks) != 0 {
		raw, err := docker(append([]string{"network", "inspect", "--"}, networks...)...)
		if err != nil {
			return err
		}
		var bridgeNetworks []struct {
			Name       string
			EnableIPv6 bool
			Options    map[string]string
		}
		if err := json.Unmarshal([]byte(raw), &bridgeNetworks); err != nil {
			return err
		}
		for _, network := range bridgeNetworks {
			if err := checkDockerNetworkOptions(network.Options); err != nil {
				return fmt.Errorf("网络 %s：%w", network.Name, err)
			}
			if !strings.Contains("\n"+nat["iptables"]+"\n", "\n-N DOCKER\n") {
				return errors.New("Docker bridge 与系统 iptables 的 IPv4 规则链不一致，请核对 iptables 后端")
			}
			if network.EnableIPv6 && !strings.Contains("\n"+nat["ip6tables"]+"\n", "\n-N DOCKER\n") {
				return errors.New("Docker IPv6 bridge 与系统 ip6tables 规则链不一致，请核对 ip6tables 后端")
			}
		}
	}
	return nil
}

func (d *dockerFirewall) checkDockerDaemonConfig(ctx context.Context) error {
	configPath := "/etc/docker/daemon.json"
	pid, err := d.run(ctx, "", "systemctl", "show", "--property=MainPID", "--value", "docker.service")
	if err == nil {
		pid = strings.TrimSpace(pid)
		if number, _ := strconv.Atoi(pid); number > 0 {
			cmdline, err := d.read("/proc/" + pid + "/cmdline")
			if err != nil {
				return err
			}
			args := strings.Split(string(cmdline), "\x00")
			for i, arg := range args {
				name, value, equals := strings.Cut(arg, "=")
				switch name {
				case "--config-file", "--firewall-backend", "--allow-direct-routing", "--iptables", "--ip6tables":
					if !equals && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
						value = args[i+1]
					}
					switch name {
					case "--config-file":
						configPath = value
					case "--firewall-backend":
						if value != "iptables" {
							return fmt.Errorf("Docker 防火墙后端 %q 需单独接入 UFW", value)
						}
					case "--allow-direct-routing":
						if value != "false" {
							return errors.New("Docker 已启用直接路由")
						}
					default:
						if value == "false" {
							return fmt.Errorf("Docker 已设置 %s=false", name)
						}
					}
				}
			}
		}
	}
	raw, err := d.read(configPath)
	if errors.Is(err, os.ErrNotExist) && configPath == "/etc/docker/daemon.json" {
		return nil
	}
	if err != nil {
		return err
	}
	var settings dockerDaemonFirewall
	if err := json.Unmarshal(raw, &settings); err != nil {
		return fmt.Errorf("读取 Docker 防火墙配置 %s：%w", configPath, err)
	}
	if settings.Backend != "" && settings.Backend != "iptables" {
		return fmt.Errorf("Docker 防火墙后端 %q 需单独接入 UFW", settings.Backend)
	}
	if (settings.IPTables != nil && !*settings.IPTables) || (settings.IP6Tables != nil && !*settings.IP6Tables) {
		return errors.New("Docker 配置关闭了 iptables 或 ip6tables")
	}
	if settings.Direct {
		return errors.New("Docker 已启用直接路由")
	}
	return checkDockerNetworkOptions(settings.NetworkDefaults["bridge"])
}
