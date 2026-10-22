package panel

import (
	"context"
	"elysian/server/internal/config"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type Worker struct {
	Store   Store
	Host    Host
	Source  Source
	Install string
}

// 回滚预算按最坏情况给足：数据快照原位恢复 + 逐条防火墙规则命令 + 启动 + 60 秒健康
// 等待；预算不足会在恢复数据或加规则途中超时，把任务打成 recovery-failed。
const rollbackBudget = 10 * time.Minute

// startFallbackBudget 是回滚失败后的兜底拉起预算（启动命令 30 秒 + 健康检查 60 秒）。
const startFallbackBudget = 2 * time.Minute

func (w Worker) install() string {
	if w.Install != "" {
		return w.Install
	}
	return InstallRoot
}
func (w Worker) phase(r *taskRecord, phase string) error {
	r.Phase = phase
	r.UpdatedAt = time.Now().UTC()
	labels := map[string]string{"checking": "检查部署环境", "downloading": "下载源码", "building": "构建新版本", "firewall": "调整防火墙", "stopping": "停止面板", "activating": "切换配置与版本", "verifying": "检查服务健康", "finished": "任务已结束"}
	w.Store.appendLog(r.ID, r.UpdatedAt.Format(time.RFC3339)+" "+labels[phase]+"\n")
	return w.Store.lock(func() error { return w.Store.save(*r) })
}

func (w Worker) Run(ctx context.Context, id string) (retErr error) {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("任务编号无效")
	}
	f, err := os.OpenFile(filepath.Join(w.Store.tasksDir(), "worker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("另一项维护任务正在执行")
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	r, err := w.Store.read(id)
	if err != nil {
		return err
	}
	defer func() {
		if !Active(r.State) && r.State != "recovery-failed" && r.Worker != "" {
			_ = os.Remove(r.Worker)
		}
	}()
	// panic 兜底：异常退出也走与普通失败相同的回滚与终态收敛，任务不冻结在 running。
	defer func() {
		if p := recover(); p != nil {
			retErr = w.finishFailure(&r, fmt.Errorf("维护进程异常退出：%v", p))
		}
	}()
	if !Active(r.State) {
		return nil
	}
	// HTTP 响应有机会到达浏览器，任务已持久化，不依赖请求生命周期。
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
	}
	r.State = "running"
	if err = w.phase(&r, "checking"); err != nil {
		return err
	}
	if err = w.execute(ctx, &r); err == nil {
		return nil
	}
	return w.finishFailure(&r, err)
}

// finishFailure 把失败任务收敛为终态：先按快照与捕获的规则回滚；回滚失败时尽力把旧
// 服务拉起（杜绝恢复失败后面板停留在停止态）、落 recovery-failed 并附服务器侧恢复
// 指引；未动过配置、数据或防火墙的失败不再回滚，直接判 failed。
func (w Worker) finishFailure(r *taskRecord, cause error) error {
	r.Error = cause.Error()
	w.Store.appendLog(r.ID, "维护失败："+r.Error+"\n")
	recoverCtx, cancel := context.WithTimeout(context.Background(), rollbackBudget)
	defer cancel()
	if e := w.rollback(recoverCtx, r, true); e != nil {
		r.State = "recovery-failed"
		r.Error += "；恢复失败：" + e.Error() + recoveryHint(r.ID)
		w.ensureStarted(r)
	} else if r.Activated || r.FirewallCaptured {
		r.State = "rolled-back"
	} else {
		r.State = "failed"
	}
	if e := w.phase(r, "finished"); e != nil {
		return fmt.Errorf("%w；任务结果保存失败：%v", cause, e)
	}
	return cause
}

// ensureStarted 在回滚失败后尽力把面板服务拉起：面板进程自身停着比配置未完全恢复
// 更糟——用户会彻底失去面板入口。使用独立短预算，不占用回滚预算。
func (w Worker) ensureStarted(r *taskRecord) {
	if !r.Activated {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), startFallbackBudget)
	defer cancel()
	if err := w.Host.Start(ctx); err != nil {
		w.Store.appendLog(r.ID, "恢复后面板启动失败："+err.Error()+"\n")
		return
	}
	if err := w.Host.Healthy(ctx, r.OldPorts, ""); err != nil {
		w.Store.appendLog(r.ID, "恢复后面板健康检查未通过："+err.Error()+"\n")
	}
}

// recoveryHint 是恢复失败任务的服务器侧固定指引：回滚需要停掉面板自身，面板进程内
// 无法安全执行，恢复动作收敛在服务重启时的 ExecStartPre（maintenance-recover）。
func recoveryHint(id string) string {
	return "。请在服务器执行 systemctl restart elysian（启动前会自动恢复原版本与配置），并用 journalctl -u elysian-maintenance-" + id + " 查看维护现场"
}

func (w Worker) execute(ctx context.Context, r *taskRecord) error {
	current, err := config.ReadPanelNetwork(w.Store.networkPath())
	if err != nil {
		return err
	}
	if current != r.OldPorts {
		return fmt.Errorf("端口配置已变化，请刷新后重试")
	}
	if err = w.Host.Preflight(ctx, r.OldPorts, r.NewPorts); err != nil {
		return err
	}
	r.PreviousBinary, err = filepath.EvalSymlinks(filepath.Join(w.install(), "current", "elysian"))
	if err != nil {
		return err
	}
	if err = w.phase(r, "checking"); err != nil {
		return err
	}
	if r.Kind == "update" {
		strategy := "最新提交"
		if r.UpdateChannel == ChannelRelease {
			strategy = "最新发版 " + r.ReleaseTag
		}
		w.Store.appendLog(r.ID, "更新策略："+strategy+"；目标提交："+r.TargetCommit+"\n")
		stage := filepath.Join("/var/tmp/elysian-build", r.ID)
		defer os.RemoveAll(stage)
		if err = os.MkdirAll(filepath.Dir(stage), 0711); err != nil {
			return err
		}
		source := filepath.Join(stage, "source")
		if err = w.phase(r, "downloading"); err != nil {
			return err
		}
		if err = w.Source.Download(ctx, r.TargetCommit, source); err != nil {
			return err
		}
		if err = w.phase(r, "building"); err != nil {
			return err
		}
		buildCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		r.Candidate, err = w.Host.Build(buildCtx, source, r.TargetCommit, r.ID)
		if err != nil {
			return err
		}
	}
	if err = w.Host.Preflight(ctx, r.OldPorts, r.NewPorts); err != nil {
		return err
	}
	rules, err := w.Host.Rules(ctx)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		if managedRule(rule) && relevantRule(rule, r.OldPorts, r.NewPorts) {
			r.FirewallBefore = append(r.FirewallBefore, rule)
		}
	}
	r.FirewallCaptured = true
	if err = w.phase(r, "firewall"); err != nil {
		return err
	}
	// 先开新入口；交换端口时先撤销后端端口的旧面板规则。
	for _, rule := range r.FirewallBefore {
		if ruleCovers(rule, r.NewPorts.BackendPort) {
			if err = w.Host.DeleteRule(ctx, rule); err != nil {
				return err
			}
		}
	}
	if err = w.Host.AddRule(ctx, frontendRule(r.NewPorts.FrontendPort)); err != nil {
		return err
	}
	if err = w.phase(r, "stopping"); err != nil {
		return err
	}
	if err = w.Host.Stop(ctx); err != nil {
		return err
	}
	if err = w.Host.Preflight(ctx, r.OldPorts, r.NewPorts); err != nil {
		return err
	}
	r.Snapshot = filepath.Join(w.Store.Root, "backups", "panel-maintenance", r.ID)
	if err = copyPanelData(w.Store.Root, r.Snapshot); err != nil {
		return err
	}
	r.SnapshotReady = true
	r.Activated = true
	if err = w.phase(r, "activating"); err != nil {
		return err
	}
	if err = config.AtomicJSON(w.Store.networkPath(), r.NewPorts); err != nil {
		return err
	}
	if r.Candidate != "" {
		if err = switchBinary(w.install(), r.Candidate, r.ID); err != nil {
			return err
		}
	}
	if err = w.Host.Start(ctx); err != nil {
		return err
	}
	if err = w.phase(r, "verifying"); err != nil {
		return err
	}
	expected := ""
	if r.Kind == "update" {
		expected = r.TargetCommit
	}
	if err = w.Host.Healthy(ctx, r.NewPorts, expected); err != nil {
		return err
	}
	rules, err = w.Host.Rules(ctx)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		if managedRule(rule) && relevantRule(rule, r.OldPorts, r.NewPorts) && !ruleCovers(rule, r.NewPorts.FrontendPort) {
			if err = w.Host.DeleteRule(ctx, rule); err != nil {
				return err
			}
		}
	}
	if err = w.Host.VerifyRules(ctx, r.NewPorts); err != nil {
		return err
	}
	r.Committed = true
	r.State = "succeeded"
	if err = w.phase(r, "finished"); err != nil {
		r.Committed = false
		r.State = "running"
		return err
	}
	// 仅清理由自身版本目录创建的旧产物，保留当前和上一成功版本。
	if r.Candidate != "" {
		w.pruneReleases(r.Candidate, r.PreviousBinary)
	}
	return nil
}

func (w Worker) rollback(ctx context.Context, r *taskRecord, start bool) error {
	if r.Committed {
		return nil
	}
	if r.Activated {
		if start {
			if err := w.Host.Stop(ctx); err != nil {
				return err
			}
		}
		if r.SnapshotReady {
			if err := restorePanelData(r.Snapshot, w.Store.Root); err != nil {
				return err
			}
		}
		if r.PreviousBinary != "" {
			if err := switchBinary(w.install(), r.PreviousBinary, r.ID); err != nil {
				return err
			}
		}
	}
	if r.FirewallCaptured {
		current, err := w.Host.Rules(ctx)
		if err != nil {
			return err
		}
		for _, rule := range current {
			if managedRule(rule) && relevantRule(rule, r.OldPorts, r.NewPorts) {
				if err = w.Host.DeleteRule(ctx, rule); err != nil {
					return err
				}
			}
		}
		for _, rule := range r.FirewallBefore {
			if err = w.Host.AddRule(ctx, rule); err != nil {
				return err
			}
		}
	}
	if start {
		if err := w.Host.Start(ctx); err != nil {
			return err
		}
		if r.Activated {
			return w.Host.Healthy(ctx, r.OldPorts, "")
		}
	}
	return nil
}

// Recover 在 systemd ExecStartPre 执行；活动 worker 自己负责事务，不与它竞争。
func (w Worker) Recover(ctx context.Context) error {
	if err := os.MkdirAll(w.Store.tasksDir(), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(w.Store.tasksDir(), "worker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if err == syscall.EWOULDBLOCK {
			return nil
		}
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	rows, err := w.Store.records()
	if err != nil {
		return err
	}
	for _, r := range rows {
		if !Active(r.State) && r.State != "recovery-failed" {
			continue
		}
		if r.Committed {
			r.State = "succeeded"
			r.Error = ""
			if err = w.phase(&r, "finished"); err != nil {
				return err
			}
			_ = os.Remove(r.Worker)
			continue
		}
		if w.Host.WorkerActive(ctx, r.ID) {
			continue
		}
		if err = w.rollback(ctx, &r, false); err != nil {
			return fmt.Errorf("中断任务 %s 恢复失败：%w", r.ID, err)
		}
		r.State = "rolled-back"
		r.Error = "维护任务中断，已恢复原版本与配置"
		if err = w.phase(&r, "finished"); err != nil {
			return err
		}
		_ = os.Remove(r.Worker)
	}
	return nil
}

func switchBinary(root, binary, id string) error {
	// 安装根可能含符号链接（如 macOS 的 /var → /private/var）：PreviousBinary 一侧来自
	// EvalSymlinks 已解析，根与候选二进制也先解析再比较，否则同一版本目录会被当成
	// 两个不可比较的路径，切换与回滚全部失败。
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("面板安装目录无效：%w", err)
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return err
	}
	release := filepath.Dir(binary)
	relative, err := filepath.Rel(filepath.Join(resolved, "releases"), release)
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) || len(relative) >= 3 && relative[:3] == "../" {
		return fmt.Errorf("版本路径不在面板发布目录中")
	}
	if st, err := os.Lstat(binary); err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("面板二进制无效")
	}
	tmp := filepath.Join(resolved, ".current-"+id)
	_ = os.Remove(tmp)
	if err = os.Symlink(release, tmp); err != nil {
		return err
	}
	defer os.Remove(tmp)
	return os.Rename(tmp, filepath.Join(resolved, "current"))
}
func (w Worker) pruneReleases(current, previous string) {
	// 比较前统一解析符号链接：/var 与 /private/var 指向同一目录时不算两个版本目录，
	// 否则上一成功版本会被当成多余产物清掉。
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return p
	}
	keep := map[string]bool{resolve(filepath.Dir(current)): true, resolve(filepath.Dir(previous)): true}
	entries, err := os.ReadDir(filepath.Join(w.install(), "releases"))
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(w.install(), "releases", e.Name())
		if e.IsDir() && !keep[resolve(p)] {
			_ = os.RemoveAll(p)
		}
	}
}

func copyTree(from, to string, excludeTasks bool) error {
	return copyTreeExcept(from, to, excludeTasks, nil)
}

func copyTreeExcept(from, to string, excludeTasks bool, skip func(string) bool) error {
	if _, err := os.Stat(from); os.IsNotExist(err) {
		return nil
	}
	return filepath.WalkDir(from, func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, name)
		if err != nil {
			return err
		}
		if excludeTasks && rel == "panel-maintenance" {
			return filepath.SkipDir
		}
		if skip != nil && skip(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("面板数据备份不允许符号链接：%s", name)
		}
		target := filepath.Join(to, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			err = os.MkdirAll(target, info.Mode().Perm())
		} else {
			err = copyRegular(name, target, info.Mode().Perm())
		}
		if err != nil {
			return err
		}
		if err = os.Chmod(target, info.Mode().Perm()); err != nil {
			return err
		}
		if owner, ok := info.Sys().(*syscall.Stat_t); ok {
			return os.Chown(target, int(owner.Uid), int(owner.Gid))
		}
		return nil
	})
}
func copyPanelData(root, destination string) error {
	for _, dir := range []string{"config", "data", "state"} {
		if err := copyTree(filepath.Join(root, dir), filepath.Join(destination, dir), dir == "state"); err != nil {
			return err
		}
	}
	return nil
}
func restorePanelData(snapshot, root string) error {
	// 服务已停止。先持久化工作流冻结标记，再原位保留全部当前 Agent
	// 事实、配置和工作区；完成回执与未知执行屏障都不得倒退到旧快照。
	preserveAgent, err := prepareAgentRestore(snapshot, root)
	if err != nil {
		return err
	}
	for _, dir := range []string{"config", "data", "state"} {
		target := filepath.Join(root, dir)
		skip := func(name string) bool {
			return dir == "state" && name == "panel-maintenance" || preserveAgent && agentDataEntry(dir, name)
		}
		if dir == "state" || preserveAgent {
			entries, err := os.ReadDir(target)
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			for _, e := range entries {
				if !skip(e.Name()) {
					if err = os.RemoveAll(filepath.Join(target, e.Name())); err != nil {
						return err
					}
				}
			}
		} else if err := os.RemoveAll(target); err != nil {
			return err
		}
		if err := copyTreeExcept(filepath.Join(snapshot, dir), target, false, skip); err != nil {
			return err
		}
	}
	return nil
}
