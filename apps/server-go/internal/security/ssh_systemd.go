package security

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"elysian/server/internal/config"
)

// 运行模式只从装配层传入，域内不探测环境变量。
func newConfiguredSshDeps(options Deps) *sshHostDeps {
	d := newRealSshDepsWithWorkspace(options.Now, nil)
	d.runtimeMode = "docker"
	d.ports = options.SshPorts
	d.copyMetadata = copySshMetadata
	d.effectiveConfig = func(user string) (string, error) {
		args := []string{"-T", "-f", defaultSshPaths().sshdConfig}
		if user != "" {
			args = append(args, "-C", "user="+user+",host=localhost,addr=127.0.0.1")
		}
		return d.runSshd(args)
	}
	d.verifyConfig = (&systemdSSH{run: execToStdout}).verifyListeners
	d.loginHistory = newSshHistoryReader(options.Mode == config.ModeBareMetal, d)
	if options.Mode == config.ModeBareMetal {
		d.runtimeMode = "bare-metal"
		host := &systemdSSH{run: execToStdout, read: d.readText, write: d.writeText, mkdir: d.mkdir, remove: d.remove, exists: d.exists, rename: d.rename, statePath: filepath.Join(filepath.Dir(defaultSshPaths().changedAtStamp), "ssh-systemd.json"), configText: func() (string, error) { return d.effectiveConfig("") }}
		d.serviceState = host.running
		d.setEnabled = host.setEnabled
		d.applyConfig = host.apply
		d.verifyConfig = host.verifyListeners
		d.captureServiceState = host.captureState
		d.validateRuntime = host.validateRuntime
	}
	return d
}

func copySshMetadata(source, target string) error {
	f, err := os.OpenFile(source, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err = chmodNoFollow(target, uint32(info.Mode().Perm())); err != nil {
		return err
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return chownNoFollow(target, int(stat.Uid), int(stat.Gid))
	}
	return nil
}

type systemdSSH struct {
	run        func(string, []string) (string, error)
	read       func(string) (string, error)
	write      func(string, string) error
	mkdir      func(string) error
	remove     func(string) error
	exists     func(string) bool
	rename     func(string, string) error
	statePath  string
	configText func() (string, error)
}

type sshUnit struct {
	name            string
	active, enabled bool
	values          map[string]string
}

func (h *systemdSSH) unit(name string) (sshUnit, error) {
	out, err := h.run("systemctl", []string{"show", name, "--no-pager", "--property=Id,LoadState,ActiveState,UnitFileState,TriggeredBy,ExecStart,Listen,MainPID"})
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "not be found") || strings.Contains(err.Error(), "not exist") {
			return sshUnit{}, nil
		}
		return sshUnit{}, fmt.Errorf("无法读取 SSH 系统服务：%w", err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if ok {
			values[k] = v
		}
	}
	if values["LoadState"] == "not-found" || values["LoadState"] == "" {
		return sshUnit{}, nil
	}
	unitName := values["Id"]
	if unitName == "" {
		unitName = name
	}
	if unitName != "ssh.service" && unitName != "sshd.service" && unitName != "ssh.socket" && unitName != "sshd.socket" {
		return sshUnit{}, fmt.Errorf("不支持的 SSH 系统单元 %s", unitName)
	}
	return sshUnit{name: unitName, active: values["ActiveState"] == "active" || values["ActiveState"] == "activating", enabled: strings.HasPrefix(values["UnitFileState"], "enabled"), values: values}, nil
}
func (h *systemdSSH) units() (sshUnit, sshUnit, error) {
	var service sshUnit
	for _, name := range []string{"ssh.service", "sshd.service"} {
		u, err := h.unit(name)
		if err != nil {
			return service, sshUnit{}, err
		}
		if u.name != "" {
			service = u
			break
		}
	}
	if service.name == "" {
		return service, sshUnit{}, errors.New("未找到 ssh.service 或 sshd.service，请检查 OpenSSH 安装")
	}
	// 仅管理 OpenSSH 的两个标准 socket，未知触发器保守拒绝。
	for _, name := range strings.Fields(service.values["TriggeredBy"]) {
		if name != "ssh.socket" && name != "sshd.socket" {
			return service, sshUnit{}, fmt.Errorf("SSH 使用不支持的激活单元 %s，请人工检查", name)
		}
	}
	var socket sshUnit
	for _, name := range []string{"ssh.socket", "sshd.socket"} {
		u, err := h.unit(name)
		if err != nil {
			return service, socket, err
		}
		if socket.name == "" && u.name != "" {
			socket = u
		}
		if u.name != "" && (u.active || u.enabled || strings.Contains(service.values["TriggeredBy"], name)) {
			socket = u
			break
		}
	}
	return service, socket, nil
}
func (h *systemdSSH) command(action string, unit string) error {
	if unit == "" {
		return nil
	}
	_, err := h.run("systemctl", []string{action, unit})
	if err != nil {
		return fmt.Errorf("SSH 系统服务 %s %s 失败：%w", action, unit, err)
	}
	return nil
}
func (h *systemdSSH) running() (bool, error) {
	s, k, err := h.units()
	return s.active || k.active, err
}

type sshActivation struct {
	Mode string `json:"mode"`
}

func (h *systemdSSH) setEnabled(enabled bool) (err error) {
	s, k, err := h.units()
	if err != nil {
		return err
	}

	// 部分命令失败时按请求前的准确单元状态恢复，不将失败伪装为成功。
	touched := false
	defer func() {
		if err != nil && touched {
			if rb := h.restore(s, k); rb != nil {
				err = fmt.Errorf("%w；恢复 SSH 原状态失败：%v", err, rb)
			}
		}
	}()
	if !enabled {
		mode := "service"
		if k.active || k.enabled {
			mode = "socket"
		}
		if s.active || s.enabled || k.active || k.enabled {
			if err = h.mkdir(filepath.Dir(h.statePath)); err != nil {
				return err
			}
			data, _ := json.Marshal(sshActivation{Mode: mode})
			tmp := h.statePath + ".tmp"
			if err = h.write(tmp, string(data)); err != nil {
				return err
			}
			if err = osRenameSshState(h, tmp, h.statePath); err != nil {
				return err
			}
		}
		touched = true
		if err = h.command("disable", k.name); err != nil {
			return err
		}
		if err = h.command("stop", k.name); err != nil {
			return err
		}
		if err = h.command("disable", s.name); err != nil {
			return err
		}
		return h.command("stop", s.name)
	}
	mode := "service"
	if k.active || k.enabled {
		mode = "socket"
	}
	if raw, e := h.read(h.statePath); e == nil {
		var a sshActivation
		if json.Unmarshal([]byte(raw), &a) == nil && (a.Mode == "socket" || a.Mode == "service") {
			mode = a.Mode
		}
	}
	if s.values["UnitFileState"] == "masked" || (mode == "socket" && k.values["UnitFileState"] == "masked") {
		return errors.New("SSH 系统单元已被管理员屏蔽，请先人工解除屏蔽")
	}
	touched = true
	if mode == "socket" {
		if k.name == "" {
			return errors.New("原 SSH socket 激活单元已不存在，请检查 OpenSSH 安装")
		}
		if err = h.command("enable", k.name); err != nil {
			return err
		}
		return h.command("start", k.name)
	}
	if err = h.command("enable", s.name); err != nil {
		return err
	}
	return h.command("start", s.name)
}

// 以接线原语写入完整状态；真实磁盘 rename 与 fake 文件系统都可注入。
func osRenameSshState(h *systemdSSH, from, to string) error { return h.rename(from, to) }

func (h *systemdSSH) captureState() (func() error, error) {
	s, k, err := h.units()
	if err != nil {
		return nil, err
	}
	path := ""
	old := ""
	existed := false
	if k.name != "" {
		path = filepath.Join("/etc/systemd/system", k.name+".d", "90-elysian-listen.conf")
		existed = h.exists(path)
		if existed {
			old, err = h.read(path)
			if err != nil {
				return nil, err
			}
		}
	}
	return func() error {
		if path != "" {
			var e error
			if existed {
				e = h.write(path, old)
			} else {
				e = h.remove(path)
			}
			if e != nil {
				return e
			}
			if _, e = h.run("systemctl", []string{"daemon-reload"}); e != nil {
				return e
			}
		}
		// 释放失败的新监听，再按原单元状态恢复。
		if e := h.command("stop", s.name); e != nil {
			return e
		}
		if e := h.command("stop", k.name); e != nil {
			return e
		}
		return h.restore(s, k)
	}, nil
}

func (h *systemdSSH) validateRuntime() error {
	s, _, err := h.units()
	if err != nil {
		return err
	}
	// MainPID 的命令行包含真正展开后的 SSHD_OPTS；未启动时核对系统环境文件。
	if pid := s.values["MainPID"]; pid != "" && pid != "0" {
		raw, e := h.read("/proc/" + pid + "/cmdline")
		if e != nil {
			return fmt.Errorf("无法核对 SSH 启动参数：%w", e)
		}
		if regexp.MustCompile(`(?:^|[\x00\s])-(?:f|p|o)(?:[\x00\s]|\S)`).MatchString(raw) {
			return errors.New("SSH 使用自定义 -f、-p 或 -o 启动参数，请先人工整理系统服务配置")
		}
	} else {
		raw, _ := h.read("/etc/default/ssh")
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "SSHD_OPTS=") {
				value := strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "SSHD_OPTS=")), "\"'")
				if value != "" {
					return errors.New("SSH 配置了自定义 SSHD_OPTS，请先人工核对启动参数")
				}
			}
		}
	}
	return nil
}

func (h *systemdSSH) restore(s, k sshUnit) error {
	var errs []error
	// 先恢复启动策略，再恢复监听；不重启已存在的 SSH 会话子进程。
	for _, u := range []sshUnit{s, k} {
		if u.name == "" {
			continue
		}
		action := "disable"
		if u.enabled {
			action = "enable"
		}
		if e := h.command(action, u.name); e != nil {
			errs = append(errs, e)
		}
	}
	for _, u := range []sshUnit{k, s} {
		if u.name == "" {
			continue
		}
		action := "stop"
		if u.active {
			action = "start"
		}
		if e := h.command(action, u.name); e != nil {
			errs = append(errs, e)
		}
	}
	return errors.Join(errs...)
}
func (h *systemdSSH) apply(portChanged bool) (err error) {
	s, k, err := h.units()
	if err != nil {
		return err
	}
	if !s.active && !k.active {
		return nil
	}
	if !portChanged {
		if s.active {
			return h.command("reload", s.name)
		}
		return nil
	}
	if k.active {
		// 保留有效配置声明的监听地址，不扩大到其他网卡；只写面板自己的 drop-in。
		text, e := h.configText()
		if e != nil {
			return e
		}
		addresses := []string{}
		for _, line := range strings.Split(text, "\n") {
			fields := strings.Fields(line)
			if len(fields) == 2 && fields[0] == "listenaddress" {
				addresses = append(addresses, fields[1])
			}
		}
		if len(addresses) == 0 {
			return errors.New("无法从 SSH 生效配置确定 socket 监听地址")
		}
		sort.Strings(addresses)
		path := filepath.Join("/etc/systemd/system", k.name+".d", "90-elysian-listen.conf")
		old, oldErr := h.read(path)
		if oldErr != nil && h.exists(path) {
			return oldErr
		}
		if e = h.mkdir(filepath.Dir(path)); e != nil {
			return e
		}
		if e = h.write(path, "[Socket]\nListenStream=\nListenStream="+strings.Join(addresses, "\nListenStream=")+"\n"); e != nil {
			return e
		}
		defer func() {
			if err != nil {
				if oldErr == nil {
					_ = h.write(path, old)
				} else {
					_ = h.remove(path)
				}
				_, _ = h.run("systemctl", []string{"daemon-reload"})
			}
		}()
		if err = h.command("stop", s.name); err != nil {
			return err
		}
		if err = h.command("stop", k.name); err != nil {
			return err
		}
		if _, err = h.run("systemctl", []string{"daemon-reload"}); err != nil {
			return err
		}
		if err = h.command("start", k.name); err != nil {
			return err
		}
		if s.active {
			return h.command("start", s.name)
		}
		return nil
	}
	return h.command("restart", s.name)
}
func sshListenPorts(text string) map[int]bool {
	ports := map[int]bool{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "port" {
			n, _ := strconv.Atoi(f[1])
			ports[n] = true
		}
	}
	return ports
}
func (h *systemdSSH) verifyListeners(port int) error {
	for attempt := 0; attempt < 20; attempt++ {
		out, err := h.run("ss", []string{"-H", "-lntp"})
		if err != nil {
			return fmt.Errorf("无法核对 SSH 实际监听：%w", err)
		}
		found := false
		unexpected := false
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			_, p, e := net.SplitHostPort(f[3])
			if e != nil {
				continue
			}
			n, _ := strconv.Atoi(p)
			owned := strings.Contains(line, "\"sshd\"") || strings.Contains(line, "\"systemd\"")
			if n == port && owned {
				found = true
			}
			if strings.Contains(line, "\"sshd\"") && n != port {
				unexpected = true
			}
		}
		if found && !unexpected {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("SSH 实际监听未收敛到端口 %d，请检查 socket 覆盖或自定义启动参数", port)
}
