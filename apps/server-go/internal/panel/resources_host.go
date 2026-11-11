package panel

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func (h SystemHost) ObserveResources(ctx context.Context) (resourceObservation, error) {
	var out resourceObservation
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return out, fmt.Errorf("无法读取更新所需的宿主内存状态：%w", err)
	}
	out.Memory, err = parseResourceMemory(string(data))
	if err != nil {
		return out, err
	}
	load, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return out, fmt.Errorf("无法读取系统负载：%w", err)
	}
	fields := strings.Fields(string(load))
	if len(fields) < 3 {
		return out, fmt.Errorf("系统负载读数无效")
	}
	for i := 0; i < 3; i++ {
		v, e := strconv.ParseFloat(fields[i], 64)
		if e != nil || v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return out, fmt.Errorf("系统负载读数无效")
		}
		out.Load[i] = v
	}
	diskObserved := false
	for _, path := range []string{"/var/tmp", InstallRoot, h.Store.Root} {
		for {
			if _, e := os.Stat(path); e == nil {
				break
			}
			parent := filepath.Dir(path)
			if parent == path {
				return out, fmt.Errorf("无法核对构建磁盘空间")
			}
			path = parent
		}
		var stat syscall.Statfs_t
		if err = syscall.Statfs(path, &stat); err != nil {
			return out, fmt.Errorf("无法核对构建磁盘空间：%w", err)
		}
		free := stat.Bavail * uint64(stat.Bsize)
		if !diskObserved || free < out.DiskAvailable {
			out.DiskAvailable = free
		}
		diskObserved = true
	}
	out.ActiveAgentRuns, err = readActiveAgentRuns(ctx, h.Store.Root)
	return out, err
}
func parseResourceMemory(raw string) (ResourceMemory, error) {
	values := map[string]uint64{}
	for _, line := range strings.Split(raw, "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || f[2] != "kB" {
			continue
		}
		n, e := strconv.ParseUint(f[1], 10, 64)
		if e == nil && n <= math.MaxUint64/1024 {
			values[strings.TrimSuffix(f[0], ":")] = n * 1024
		}
	}
	total, tok := values["MemTotal"]
	available, aok := values["MemAvailable"]
	if !tok || !aok || total == 0 || available > total {
		return ResourceMemory{}, fmt.Errorf("无法确认 MemTotal／MemAvailable，未开始更新")
	}
	if values["SwapFree"] > values["SwapTotal"] {
		return ResourceMemory{}, fmt.Errorf("交换空间读数无效")
	}
	return ResourceMemory{TotalBytes: total, AvailableBytes: available, RequiredBytes: requiredBuildMemory, SwapTotalBytes: values["SwapTotal"], SwapFreeBytes: values["SwapFree"]}, nil
}
func readActiveAgentRuns(ctx context.Context, root string) (int, error) {
	path := filepath.Join(root, "data", "harness.sqlite")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行")
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return 0, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var exists bool
	if err = db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='runs')").Scan(&exists); err != nil {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行：%w", err)
	}
	if !exists {
		return 0, nil
	}
	var n int
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted') AND json_extract(document,'$.sessionId') IS NOT NULL AND json_extract(document,'$.sessionId') != ''").Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行：%w", err)
	}
	return n, nil
}

var resourceServicePattern = regexp.MustCompile(`^[a-zA-Z0-9_.@:-]+\.service$`)
var resourceBootPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var resourceServiceZeroFields = []string{"InactiveEnterTimestampMonotonic", "InactiveExitTimestampMonotonic", "ActiveEnterTimestampMonotonic", "ActiveExitTimestampMonotonic", "ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic", "MainPID", "ControlPID", "ExecMainPID", "NRestarts"}
var resourceContainerPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var resourceCommandPattern = regexp.MustCompile(`\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ;`)
var errResourceAlreadyStopped = errors.New("资源已经由其他操作停止，未派发停止请求")

func protectedResourceService(id, command string) bool {
	name := strings.ToLower(strings.TrimSuffix(id, ".service"))
	command = strings.ToLower(command)
	for _, prefix := range []string{"systemd", "dbus", "docker", "containerd", "ssh", "sshd", "network", "networkmanager", "networking", "netplan", "connman", "wpa_supplicant", "iwd", "udev", "user@", "elysian", "getty", "serial-getty", "polkit", "cron", "crond", "atd", "supervisor", "snapd", "init"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	for _, binary := range []string{"/sshd", "/dockerd", "/containerd", "/systemd", "/dbus-daemon", "/networkmanager"} {
		if strings.Contains(command, binary) {
			return true
		}
	}
	return false
}
func parseSystemProperties(raw string) (map[string]string, error) {
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("服务状态格式无法核实")
		}
		if _, duplicate := out[key]; duplicate {
			return nil, fmt.Errorf("服务状态字段重复")
		}
		out[key] = value
	}
	return out, nil
}

// systemctl's Exec* values also contain pid, timestamps and exit results. Those
// change on stop; bind only the command specification and the trusted unit files.
func staticResourceCommands(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	matches := resourceCommandPattern.FindAllStringSubmatch(raw, -1)
	if len(matches) == 0 || len(matches) != strings.Count(raw, "{ path=") {
		return nil, fmt.Errorf("服务命令定义格式未知")
	}
	out := []string{}
	for _, match := range matches {
		out = append(out, match[1], match[2], match[3])
	}
	return out, nil
}
func (h SystemHost) resourceService(ctx context.Context, unit string) (resourceTarget, resourceState, error) {
	var target resourceTarget
	var state resourceState
	if !resourceServicePattern.MatchString(unit) {
		return target, state, fmt.Errorf("服务单元名称无效")
	}
	properties := "Id,LoadState,ActiveState,SubState,InvocationID,FragmentPath,DropInPaths,MemoryCurrent,ExecStart,ExecStop,ExecStopPost,KillMode,TimeoutStopUSec,RequiredBy,RequisiteOf,BoundBy,ConsistsOf,PropagatesStopTo,StopPropagatedFrom,TriggeredBy,Triggers,UpheldBy,RefuseManualStop,BusName,Result," + strings.Join(resourceServiceZeroFields, ",")
	raw, err := h.command(ctx, "systemctl", "show", "--property="+properties, "--", unit)
	if err != nil {
		return target, state, err
	}
	p, err := parseSystemProperties(raw)
	if err != nil {
		return target, state, err
	}
	for _, property := range strings.Split(properties, ",") {
		if _, known := p[property]; !known {
			return target, state, fmt.Errorf("服务停止关系或身份字段 %s 不可用", property)
		}
	}
	if !resourceServicePattern.MatchString(p["Id"]) || p["LoadState"] != "loaded" || p["FragmentPath"] == "" || p["ExecStart"] == "" {
		return target, state, fmt.Errorf("服务定义或装载状态未知")
	}
	target.ResourceCandidate = ResourceCandidate{ID: "service:" + p["Id"], Kind: "service", Name: p["Id"]}
	if v, e := strconv.ParseUint(p["MemoryCurrent"], 10, 64); e == nil && v < math.MaxUint64 {
		target.MemoryBytes = &v
	}
	if protectedResourceService(p["Id"], p["ExecStart"]) {
		target.DisabledReason = "系统关键服务不能用于释放更新资源"
	}
	for _, property := range []string{"RequiredBy", "RequisiteOf", "BoundBy", "ConsistsOf", "PropagatesStopTo", "StopPropagatedFrom", "TriggeredBy", "Triggers", "UpheldBy", "BusName"} {
		if p[property] != "" {
			target.DisabledReason = "服务存在连带停止或自动激活关系，需使用原管理方式处理"
		}
	}
	if p["RefuseManualStop"] != "no" {
		target.DisabledReason = "服务拒绝手动停止或停止策略未知"
	}
	info, err := os.Lstat(p["FragmentPath"])
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return target, state, fmt.Errorf("服务定义文件身份无法核实")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 {
		return target, state, fmt.Errorf("服务定义文件归属或权限不可信")
	}
	definition, err := os.ReadFile(p["FragmentPath"])
	if err != nil {
		return target, state, err
	}
	definitions := []string{string(definition)}
	for _, path := range strings.Fields(p["DropInPaths"]) {
		if !filepath.IsAbs(path) || strings.Contains(path, "\\") {
			return target, state, fmt.Errorf("服务附加定义路径未知")
		}
		st, e := os.Lstat(path)
		if e != nil || !st.Mode().IsRegular() || st.Size() > 1<<20 {
			return target, state, fmt.Errorf("服务附加定义身份未知")
		}
		identity, ok := st.Sys().(*syscall.Stat_t)
		if !ok || identity.Uid != 0 || st.Mode().Perm()&0022 != 0 {
			return target, state, fmt.Errorf("服务附加定义归属或权限不可信")
		}
		content, e := os.ReadFile(path)
		if e != nil {
			return target, state, e
		}
		definitions = append(definitions, path, string(content))
	}
	commands := [][]string{}
	for _, key := range []string{"ExecStart", "ExecStop", "ExecStopPost"} {
		command, e := staticResourceCommands(p[key])
		if e != nil {
			return target, state, e
		}
		commands = append(commands, command)
	}
	target.Identity = resourceDigest([]any{p["Id"], p["FragmentPath"], commands, p["KillMode"], p["TimeoutStopUSec"], definitions})
	boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if bootErr != nil {
		return target, state, fmt.Errorf("无法核对服务宿主启动代次")
	}
	target.Generation, err = resourceServiceGeneration(p, strings.TrimSpace(string(boot)))
	if err != nil {
		return target, state, err
	}
	switch p["ActiveState"] {
	case "active":
		if p["SubState"] != "running" {
			return target, state, fmt.Errorf("服务运行阶段不允许维护停止")
		}
		state.Running = true
	case "inactive", "failed":
	case "activating", "deactivating", "reloading":
		return target, state, fmt.Errorf("服务正在变更状态")
	default:
		return target, state, fmt.Errorf("服务运行状态未知")
	}
	state.Identity, state.Generation = target.Identity, target.Generation
	return target, state, nil
}
func resourceServiceGeneration(p map[string]string, boot string) (string, error) {
	if !resourceBootPattern.MatchString(boot) {
		return "", fmt.Errorf("宿主启动代次未知")
	}
	if p["ActiveState"] == "active" {
		if !idPattern.MatchString(p["InvocationID"]) {
			return "", fmt.Errorf("服务启动代次未知")
		}
		return boot + ":active:" + p["InvocationID"], nil
	}
	stamp, err := strconv.ParseUint(p["InactiveEnterTimestampMonotonic"], 10, 64)
	if err != nil {
		return "", fmt.Errorf("服务停止代次未知")
	}
	if stamp == 0 {
		// systemd can discard inactive unit history, including within one boot.
		// Record an explicit unknown generation; zero fields never prove that no
		// external start/stop occurred and cannot authorize an automatic start.
		if p["ActiveState"] != "inactive" || p["SubState"] != "dead" || p["Result"] != "success" || p["InvocationID"] != "" && p["InvocationID"] != strings.Repeat("0", 32) {
			return "", fmt.Errorf("服务停止代次未知")
		}
		for _, key := range resourceServiceZeroFields {
			value, e := strconv.ParseUint(p[key], 10, 64)
			if e != nil || value != 0 {
				return "", fmt.Errorf("服务本次启动后的运行痕迹无法排除")
			}
		}
		return boot + ":inactive:unknown", nil
	}
	return boot + ":inactive:" + strconv.FormatUint(stamp, 10), nil
}
func resourceDigest(value any) string {
	b, _ := json.Marshal(value)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (h SystemHost) resourceEngine(ctx context.Context, method, path string, out any) error {
	socket := h.DockerSocket
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second}
	request, err := http.NewRequestWithContext(ctx, method, "http://docker/v1.41"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 204 && response.StatusCode != 304 {
		return fmt.Errorf("Docker 资源核对失败：HTTP %d", response.StatusCode)
	}
	if out == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		return err
	}
	return json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(out)
}
func (h SystemHost) resourceContainer(ctx context.Context, id string) (resourceTarget, resourceState, error) {
	var target resourceTarget
	var state resourceState
	if !resourceContainerPattern.MatchString(id) {
		return target, state, fmt.Errorf("容器必须使用完整 ID")
	}
	var raw map[string]json.RawMessage
	if err := h.resourceEngine(ctx, "GET", "/containers/"+id+"/json", &raw); err != nil {
		return target, state, err
	}
	var actualID, created, image, name string
	var config struct {
		Labels map[string]string `json:"Labels"`
	}
	var status struct {
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
		StartedAt  string `json:"StartedAt"`
	}
	for key, output := range map[string]any{"Id": &actualID, "Created": &created, "Image": &image, "Name": &name, "Config": &config, "State": &status} {
		if json.Unmarshal(raw[key], output) != nil {
			return target, state, fmt.Errorf("容器身份或状态不完整")
		}
	}
	if actualID != id || created == "" || image == "" || status.StartedAt == "" {
		return target, state, fmt.Errorf("容器身份或启动代次未知")
	}
	target.ResourceCandidate = ResourceCandidate{ID: "container:" + id, Kind: "container", Name: strings.TrimPrefix(name, "/")}
	if status.Paused || status.Restarting {
		target.DisabledReason = "容器正暂停或重启，不能用于更新停机"
	}
	for key, value := range config.Labels {
		if strings.HasPrefix(key, "elysian.agent.execution") || key == "elysian.panel" && value != "" {
			target.DisabledReason = "Agent 执行容器或面板容器由面板生命周期统一收尾"
		}
	}
	target.Identity = resourceDigest([]any{actualID, created, image, raw["Config"], raw["HostConfig"], raw["Mounts"]})
	target.Generation = status.StartedAt
	state = resourceState{Running: status.Running, Identity: target.Identity, Generation: target.Generation}
	return target, state, nil
}
func (h SystemHost) ResourceCandidates(ctx context.Context) ([]resourceTarget, error) {
	targets := []resourceTarget{}
	raw, err := h.command(ctx, "systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("无法核对服务停止范围：%w", err)
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		unit := fields[0]
		if !resourceServicePattern.MatchString(unit) {
			return nil, fmt.Errorf("服务清单格式无法核实")
		}
		if unit == ServiceName+".service" || seen[unit] {
			continue
		}
		seen[unit] = true
		if len(seen) > 512 {
			return nil, fmt.Errorf("活动服务过多，无法在预检预算内核对")
		}
		target, state, e := h.resourceService(ctx, unit)
		if e != nil {
			targets = append(targets, resourceTarget{ResourceCandidate: ResourceCandidate{ID: "service:" + unit, Kind: "service", Name: unit, DisabledReason: "服务状态、身份或停止范围无法核实"}})
			continue
		}
		if state.Running {
			targets = append(targets, target)
		}
	}
	var containers []struct {
		ID string `json:"Id"`
	}
	if err = h.resourceEngine(ctx, "GET", "/containers/json", &containers); err != nil {
		targets = append(targets, resourceTarget{ResourceCandidate: ResourceCandidate{ID: "service:elysian-docker-unavailable.service", Kind: "service", Name: "Docker 容器", DisabledReason: "无法核对 Docker 容器状态"}})
		return targets, nil
	}
	if len(containers) > 512 {
		return nil, fmt.Errorf("活动容器过多，无法在预检预算内核对")
	}
	var mutex sync.Mutex
	var group sync.WaitGroup
	semaphore := make(chan struct{}, 8)
	for _, container := range containers {
		id := container.ID
		group.Add(1)
		go func() {
			defer group.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				return
			}
			target, state, e := h.resourceContainer(ctx, id)
			if e != nil {
				target = resourceTarget{ResourceCandidate: ResourceCandidate{ID: "container:" + id, Kind: "container", Name: id, DisabledReason: "无法核实容器身份或停止范围"}}
			} else if !state.Running {
				return
			} else {
				statsCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
				var stats struct {
					Memory *struct {
						Usage *uint64           `json:"usage"`
						Stats map[string]uint64 `json:"stats"`
					} `json:"memory_stats"`
				}
				e = h.resourceEngine(statsCtx, "GET", "/containers/"+id+"/stats?stream=false&one-shot=true", &stats)
				cancel()
				if e == nil && stats.Memory != nil && stats.Memory.Usage != nil {
					usage := *stats.Memory.Usage
					if inactive := stats.Memory.Stats["inactive_file"]; inactive <= usage {
						usage -= inactive
					}
					target.MemoryBytes = &usage
				}
			}
			mutex.Lock()
			targets = append(targets, target)
			mutex.Unlock()
		}()
	}
	group.Wait()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("资源预检超时，未修改任何服务：%w", ctx.Err())
	}
	return targets, nil
}
func (h SystemHost) InspectResource(ctx context.Context, target resourceTarget) (resourceState, error) {
	var state resourceState
	var current resourceTarget
	var err error
	switch target.Kind {
	case "container":
		current, state, err = h.resourceContainer(ctx, strings.TrimPrefix(target.ID, "container:"))
	case "service":
		current, state, err = h.resourceService(ctx, strings.TrimPrefix(target.ID, "service:"))
	default:
		return state, fmt.Errorf("资源类型无效")
	}
	if err != nil {
		return state, err
	}
	if current.DisabledReason != "" {
		return state, fmt.Errorf("%s：%s", target.Name, current.DisabledReason)
	}
	if current.Identity != target.Identity {
		return state, fmt.Errorf("%s 身份已变化，未接管替代对象", target.Name)
	}
	return state, nil
}
func (h SystemHost) SetResourceRunning(ctx context.Context, target resourceTarget, running bool) error {
	state, err := h.InspectResource(ctx, target)
	if err != nil {
		return err
	}
	if state.Running == running {
		if !running {
			return errResourceAlreadyStopped
		}
		return nil
	}
	if state.Generation != target.Generation {
		return fmt.Errorf("%s 运行代次已变化，未变更状态", target.Name)
	}
	action := "stop"
	if running {
		action = "start"
	}
	if target.Kind == "service" {
		_, err = h.command(ctx, "systemctl", action, "--", strings.TrimPrefix(target.ID, "service:"))
		return err
	}
	path := "/containers/" + strings.TrimPrefix(target.ID, "container:") + "/" + action
	if !running {
		path += "?t=20"
	}
	return h.resourceEngine(ctx, "POST", path, nil)
}

func (h SystemHost) SupportsResourceFinalizer() bool { return true }
func (h SystemHost) PrepareResourceRecovery(ctx context.Context, id, worker string) error {
	return h.prepareResourceRecoveryAt(ctx, id, worker, filepath.Join(InstallRoot, "maintenance"))
}
func (h SystemHost) prepareResourceRecoveryAt(ctx context.Context, id, worker, maintenance string) error {
	if !idPattern.MatchString(id) || worker != filepath.Join(h.Store.tasksDir(), id+".worker") {
		return fmt.Errorf("维护恢复程序身份无效")
	}
	info, err := os.Lstat(maintenance)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("维护恢复目录不可信")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("维护恢复目录归属或权限不可信")
	}
	// Keep the upgraded recovery helper across a version rollback: old helpers cannot
	// interpret a resource ledger left by a killed worker or an interrupted reboot.
	helper := filepath.Join(maintenance, "elysian")
	if st, e := os.Lstat(helper); e != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("既有维护恢复程序不可信")
	} else if owner, ok := st.Sys().(*syscall.Stat_t); !ok || owner.Uid != 0 || st.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("既有维护恢复程序归属或权限不可信")
	}
	tmp := filepath.Join(maintenance, ".resource-helper-"+id)
	defer os.Remove(tmp)
	if _, e := os.Lstat(tmp); !os.IsNotExist(e) {
		return fmt.Errorf("维护恢复临时文件已存在，未覆盖")
	}
	if err = copyRegular(worker, tmp, 0700); err != nil {
		return err
	}
	c := exec.CommandContext(ctx, tmp, "maintenance-resource-version")
	c.Env = []string{"HOME=" + filepath.Dir(h.Store.Root), "PATH=/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin", "ELYSIAN_BARE_METAL=1", "ELYSIAN_DOCKER_SOCKET=" + h.DockerSocket}
	output, err := c.Output()
	if err != nil || strings.TrimSpace(string(output)) != "1" {
		return fmt.Errorf("新版维护恢复程序校验失败")
	}
	backup := filepath.Join(maintenance, "elysian.before-resource-v1")
	if _, e := os.Lstat(backup); os.IsNotExist(e) {
		if err = copyRegular(helper, backup, 0700); err != nil {
			return err
		}
	} else if e != nil {
		return e
	} else if st, e := os.Lstat(backup); e != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("维护恢复备份不是普通文件")
	}
	if err = os.Rename(tmp, helper); err != nil {
		return err
	}
	dir, err := os.Open(maintenance)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
