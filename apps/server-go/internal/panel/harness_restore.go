package panel

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/config"

	_ "modernc.org/sqlite"
)

// agentDataEntry 同时用于删除与复制过滤。Agent 配置、记录和工作区
// 必须与当前运行库一起保留，避免版本恢复倒退已提交的事实。
func agentDataEntry(dir, name string) bool {
	if dir == "config" {
		return name == "agent"
	}
	if dir != "data" {
		return false
	}
	return name == "skills" || name == "agent-workspaces" || name == "agent-records" || name == "harness.sqlite" ||
		strings.HasPrefix(name, "harness.sqlite-") || strings.HasPrefix(name, "harness.sqlite.")
}

// WorkflowRecoveryFencePath 是维护进程与运行内核共享的恢复冻结标记。
// 所在维护目录不参与快照恢复，标记只能在运行内核完成冻结后移除。
func WorkflowRecoveryFencePath(root string) string {
	return filepath.Join(root, "state", "panel-maintenance", "agent-workflow-recovery.json")
}

type workflowRecoveryFence struct {
	Version   int    `json:"version"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"createdAt"`
}

// prepareAgentRestore 在任何领域数据恢复前确认整组 Agent 数据可保留。
// 已完成工作流的回执同样是当前事实，不能因没有未决屏障而倒退。
func prepareAgentRestore(snapshot, root string) (bool, error) {
	current, err := inspectAgentEntries(root)
	if err != nil {
		return false, err
	}
	backedUp, err := inspectAgentEntries(snapshot)
	if err != nil {
		return false, err
	}
	if _, err := preserveAgentFacts(root); err != nil {
		return false, err
	}
	if _, err := os.Lstat(filepath.Join(root, "data", "harness.sqlite")); os.IsNotExist(err) && backedUp {
		return false, fmt.Errorf("当前运行数据库缺失而备份包含 Agent 数据，不能拼接或回放旧事实，已拒绝恢复")
	}
	if !current && !backedUp {
		return false, nil
	}
	if err := persistWorkflowRecoveryFence(root); err != nil {
		return false, fmt.Errorf("无法持久化工作流恢复冻结标记，已拒绝恢复：%w", err)
	}
	return true, nil
}

func inspectAgentEntries(root string) (bool, error) {
	present := false
	for _, dir := range []string{"config", "data"} {
		path := filepath.Join(root, dir)
		if info, err := os.Lstat(path); err == nil && !info.IsDir() {
			return false, fmt.Errorf("Agent 数据父路径不是普通目录，已拒绝恢复：%s", dir)
		} else if err != nil && !os.IsNotExist(err) {
			return false, fmt.Errorf("无法检查 Agent 数据目录，已拒绝恢复：%w", err)
		}
		entries, err := os.ReadDir(path)
		if err != nil && !os.IsNotExist(err) {
			return false, fmt.Errorf("无法检查 Agent 数据，已拒绝恢复：%w", err)
		}
		for _, entry := range entries {
			if !agentDataEntry(dir, entry.Name()) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return false, fmt.Errorf("无法检查 Agent 数据实体，已拒绝恢复：%w", err)
			}
			wantDirectory := dir == "config" && entry.Name() == "agent" ||
				dir == "data" && (entry.Name() == "skills" || entry.Name() == "agent-workspaces" || entry.Name() == "agent-records")
			if wantDirectory && !info.IsDir() || !wantDirectory && !info.Mode().IsRegular() {
				return false, fmt.Errorf("Agent 数据实体类型无效，已拒绝恢复：%s", entry.Name())
			}
			present = true
		}
	}
	return present, nil
}

func persistWorkflowRecoveryFence(root string) error {
	// .Elysian 本身在容器中可以是约定的持久卷链接；其内部状态路径不能是链接。
	for _, dir := range []string{filepath.Join(root, "state"), filepath.Join(root, "state", "panel-maintenance")} {
		info, err := os.Lstat(dir)
		if os.IsNotExist(err) {
			if err = os.Mkdir(dir, 0700); err != nil {
				return err
			}
			if err = syncRestoreDirectory(filepath.Dir(dir)); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if !info.IsDir() {
			return fmt.Errorf("恢复冻结标记目录不是普通目录")
		}
	}
	path := WorkflowRecoveryFencePath(root)
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() > 1024 || info.Mode().Perm() != 0600 {
			return fmt.Errorf("已有恢复冻结标记的类型、大小或权限无效")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var fence workflowRecoveryFence
		decoder := json.NewDecoder(bytes.NewReader(content))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&fence); err != nil {
			return fmt.Errorf("已有恢复冻结标记损坏：%w", err)
		}
		if err := decoder.Decode(new(any)); err != io.EOF || fence.Version != 1 || fence.Reason != "panel-rollback" {
			return fmt.Errorf("已有恢复冻结标记无效")
		}
		if _, err := time.Parse(time.RFC3339Nano, fence.CreatedAt); err != nil {
			return fmt.Errorf("已有恢复冻结标记时间无效")
		}
		// 保留原标记与时间，重复恢复不能抹掉尚未被内核消费的冻结事实。
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		err = file.Sync()
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		return syncRestoreDirectory(filepath.Dir(path))
	}
	if !os.IsNotExist(err) {
		return err
	}
	return config.AtomicJSON(path, workflowRecoveryFence{Version: 1, Reason: "panel-rollback", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)})
}

func syncRestoreDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// preserveAgentFacts 报告未决执行屏障或资源租约，供停服后的容器恢复判断使用。
// 只允许旧版合法库缺少对应表；损坏库与无法核实的执行状态均拒绝恢复。
func preserveAgentFacts(root string) (bool, error) {
	path := filepath.Join(root, "data", "harness.sqlite")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, sidecarErr := os.Lstat(path + suffix); sidecarErr == nil || !os.IsNotExist(sidecarErr) {
				return false, fmt.Errorf("运行数据库缺失但仍有相关文件，无法确认未决执行屏障，已拒绝恢复")
			}
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("无法读取运行数据库，已拒绝恢复：%w", err)
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("运行数据库不是普通文件，无法确认未决执行屏障，已拒绝恢复")
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return false, fmt.Errorf("无法打开运行数据库，已拒绝恢复：%w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return false, fmt.Errorf("无法确认运行数据库版本，已拒绝恢复：%w", err)
	}
	if version < 1 {
		return false, fmt.Errorf("运行数据库版本无效，已拒绝恢复")
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return false, fmt.Errorf("运行数据库完整性检查未通过，已拒绝恢复")
	}
	var hasTable bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='execution_barriers')").Scan(&hasTable); err != nil {
		return false, fmt.Errorf("无法确认执行屏障表，已拒绝恢复：%w", err)
	}
	if !hasTable {
		if version == 1 || version == 2 {
			return false, nil
		}
		return false, fmt.Errorf("运行数据库缺少执行屏障表，无法确认未决执行，已拒绝恢复")
	}
	var pending bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM execution_barriers WHERE state IN ('dispatched','unknown'))").Scan(&pending); err != nil {
		return false, fmt.Errorf("无法读取未决执行屏障，已拒绝恢复：%w", err)
	}
	if version >= 5 {
		var pendingLease bool
		if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM resource_leases WHERE state IN ('held','unknown'))").Scan(&pendingLease); err != nil {
			return false, fmt.Errorf("无法核实运行数据库中的资源租约，已拒绝恢复：%w", err)
		}
		pending = pending || pendingLease
	}
	return pending, nil
}
