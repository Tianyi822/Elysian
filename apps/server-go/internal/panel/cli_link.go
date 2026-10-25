package panel

import (
	"context"
	"elysian/server/internal/config"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// DefaultCLIBin 是全局 ely 命令的受管落点：安装脚本注册的符号链接（指向
// <InstallRoot>/current/elysian）与维护事务的补注册共用同一路径与同一归属语义
// （scripts/install.sh 的 cli_link_owned）。
const DefaultCLIBin = "/usr/local/bin/ely"

// cliBin 返回本 Worker 使用的 CLI 命令落点：缺省 /usr/local/bin/ely，测试可注入
// 临时路径，避免在系统目录留下测试产物。
func (w Worker) cliBin() string {
	if w.CLIBin != "" {
		return w.CLIBin
	}
	return DefaultCLIBin
}

// cliLinkAction 表示 CLI 落点现状的判定结果。
type cliLinkAction int

const (
	cliLinkMissing cliLinkAction = iota
	cliLinkCanonical
	cliLinkOwnedOther
	cliLinkOccupied
)

// hasDotDot 报告路径是否含「..」成分：带逃逸成分的链接文本不允许只凭落在安装根下
// 的字面前缀判定为自家（/opt/elysian/../foreign 形态）。
func hasDotDot(p string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// classifyCLILink 判定 CLI 落点现状：缺失、精确受管文本（<root>/current/elysian）、
// 自家其他形态（解析后真实路径落在 current/elysian 或 releases/ 下），或外部占用
// （普通文件、断链非受管文本、逃逸或指向安装根外的链接）。
func classifyCLILink(root, cliPath, managedText string) (cliLinkAction, error) {
	info, err := os.Lstat(cliPath)
	if err != nil {
		if os.IsNotExist(err) {
			return cliLinkMissing, nil
		}
		return 0, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return cliLinkOccupied, nil
	}
	text, err := os.Readlink(cliPath)
	if err != nil {
		return 0, err
	}
	if text == managedText {
		return cliLinkCanonical, nil
	}
	if hasDotDot(text) {
		return cliLinkOccupied, nil
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return 0, err
	}
	resolved, err := filepath.EvalSymlinks(cliPath)
	if err != nil {
		// 断链且非受管文本：保守判外部，不动。
		return cliLinkOccupied, nil
	}
	if resolved == filepath.Join(resolvedRoot, "current", "elysian") ||
		strings.HasPrefix(resolved, filepath.Join(resolvedRoot, "releases")+string(os.PathSeparator)) {
		return cliLinkOwnedOther, nil
	}
	return cliLinkOccupied, nil
}

// atomicSymlink 以「临时链接＋重命名」原子替换 path 的指向，tag 保证临时名不冲突。
func atomicSymlink(target, path, tag string) error {
	tmp := path + ".elysian-" + tag
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncLinkDirectory(path)
}

// verifyCLIVersion 执行 ely --version 并校验输出包含构建标识；CLIVerify 非空时走注入
// 桩（测试避免执行假二进制）。
func (w Worker) verifyCLIVersion(ctx context.Context, cliPath, commit string) error {
	if w.CLIVerify != nil {
		return w.CLIVerify(ctx, cliPath, commit)
	}
	vctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, cliPath, "--version").Output()
	if err != nil {
		return fmt.Errorf("CLI 命令 ely 校验失败：%w", err)
	}
	if !strings.Contains(string(out), commit) {
		return fmt.Errorf("CLI 命令 ely 校验失败：--version 输出未包含构建标识 %s", commit)
	}
	return nil
}

// cliJournal 保存链接变更意图、原命令状态和目标构建；先落盘再修改链接。
// 新 Worker 将注册纳入维护事务；旧 Worker 提交后的补注册由新服务生命周期承接。
// 外部占用始终报错且保持原样，失败只恢复属于本次事务的命令变更。
type cliJournal struct {
	TaskID   string `json:"taskId"`
	Path     string `json:"path"`
	Target   string `json:"target"`
	Commit   string `json:"commit"`
	Original string `json:"original,omitempty"`
	Missing  bool   `json:"missing"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
}

func (s Store) cliJournalPath(id string) string {
	return filepath.Join(s.tasksDir(), "cli-registration", id+".json")
}
func (w Worker) ensureCLILink(ctx context.Context, r *taskRecord) error {
	path := w.cliBin()
	target := filepath.Join(w.install(), "current", "elysian")
	var j cliJournal
	raw, err := os.ReadFile(w.Store.cliJournalPath(r.ID))
	if err == nil {
		if err = json.Unmarshal(raw, &j); err != nil {
			return fmt.Errorf("CLI 注册日志损坏：%w", err)
		}
		if j.TaskID != r.ID || j.Path != path || j.Target != target || j.Commit != r.TargetCommit {
			return fmt.Errorf("CLI 注册日志与目标不一致")
		}
	} else if !os.IsNotExist(err) {
		return err
	} else {
		action, e := classifyCLILink(w.install(), path, target)
		if e != nil {
			return e
		}
		if action == cliLinkOccupied {
			return fmt.Errorf("CLI 注册失败：%s 已被外部文件占用，已保留原样", path)
		}
		j = cliJournal{TaskID: r.ID, Path: path, Target: target, Commit: r.TargetCommit, Missing: action == cliLinkMissing, State: "pending"}
		if !j.Missing {
			j.Original, e = os.Readlink(path)
			if e != nil {
				return e
			}
		}
	}
	// 意图和旧目标必须在链接变更之前持久化，包括重复执行和中断恢复。
	j.State = "pending"
	j.Error = ""
	if err = config.AtomicJSON(w.Store.cliJournalPath(r.ID), j); err != nil {
		return err
	}
	r.CLICreated = j.Missing
	r.CLIRelinkedFrom = ""
	if !j.Missing && j.Original != target {
		r.CLIRelinkedFrom = j.Original
	}
	r.CLIRegistration = &CLIRegistration{Status: "pending"}
	if err = w.Store.lock(func() error { return w.Store.save(*r) }); err != nil {
		return err
	}
	fail := func(cause error) error {
		if rollback := w.rollbackCLILink(r); rollback != nil {
			cause = fmt.Errorf("%w；恢复原命令失败：%v", cause, rollback)
		}
		j.State = "failed"
		j.Error = cause.Error()
		_ = config.AtomicJSON(w.Store.cliJournalPath(r.ID), j)
		r.CLIRegistration = &CLIRegistration{Status: "failed", Error: cause.Error()}
		_ = w.Store.lock(func() error { return w.Store.save(*r) })
		return cause
	}
	current, readErr := os.Readlink(path)
	switch {
	case os.IsNotExist(readErr):
		if !j.Missing {
			return fail(fmt.Errorf("CLI 原链接已消失，拒绝覆盖外部变更"))
		}
		if err = os.Symlink(target, path); err != nil {
			return fail(err)
		}
	case readErr != nil:
		return fail(fmt.Errorf("CLI 命令被其他文件占用：%w", readErr))
	case current == target:
	case !j.Missing && current == j.Original:
		if err = atomicSymlink(target, path, r.ID); err != nil {
			return fail(err)
		}
	default:
		return fail(fmt.Errorf("CLI 链接已被外部修改，保持原样"))
	}
	if err = syncLinkDirectory(path); err != nil {
		return fail(err)
	}
	if err = w.verifyCLIVersion(ctx, path, r.TargetCommit); err != nil {
		return fail(err)
	}
	j.State = "succeeded"
	if err = config.AtomicJSON(w.Store.cliJournalPath(r.ID), j); err != nil {
		return fail(err)
	}
	r.CLIRegistration = &CLIRegistration{Status: "succeeded"}
	if err = w.Store.lock(func() error { return w.Store.save(*r) }); err != nil {
		return fail(err)
	}
	return nil
}
func syncLinkDirectory(path string) error {
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// rollbackCLILink 回滚 CLI 链接善后：本次任务新建的链接移除（升级前不存在则回滚后
// 不存在）、改指过的自家链接恢复升级前原目标；只在其仍为本面板受管文本形态时动作，
// 避免误删期间被外部接管的名字。外部占用不产生这两类记录，无需处理。
func (w Worker) rollbackCLILink(r *taskRecord) error {
	if !r.CLICreated && r.CLIRelinkedFrom == "" {
		return nil
	}
	cliPath := w.cliBin()
	info, err := os.Lstat(cliPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		// 已被外部接管为普通文件：保持原样。
		return nil
	}
	text, err := os.Readlink(cliPath)
	if err != nil {
		return err
	}
	managedText := filepath.Join(w.install(), "current", "elysian")
	if text != managedText {
		return nil
	}
	switch {
	case r.CLICreated:
		if err = os.Remove(cliPath); err != nil {
			return err
		}
		if err = syncLinkDirectory(cliPath); err != nil {
			return err
		}
		w.Store.appendLog(r.ID, "回滚：移除本次注册的 CLI 命令 "+cliPath+"\n")
	case r.CLIRelinkedFrom != "":
		if err = atomicSymlink(r.CLIRelinkedFrom, cliPath, "rollback-"+r.ID); err != nil {
			return err
		}
		w.Store.appendLog(r.ID, "回滚：CLI 命令恢复升级前指向 "+r.CLIRelinkedFrom+"\n")
	}
	return nil
}
