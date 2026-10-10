package panel

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRestoreFixture(t *testing.T, root, name, value string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func createRestoreDatabase(t *testing.T, root string, statements ...string) {
	t.Helper()
	path := filepath.Join(root, "data", "harness.sqlite")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
}

func assertRestoreFixture(t *testing.T, root, name, expected string) {
	t.Helper()
	value, err := os.ReadFile(filepath.Join(root, name))
	if err != nil || string(value) != expected {
		t.Fatalf("文件 %s 内容错误：%q，%v", name, value, err)
	}
}

func TestMaintenancePreservesPendingAgentFactsDuringRestore(t *testing.T) {
	for _, state := range []string{"dispatched", "unknown"} {
		t.Run(state, func(t *testing.T) {
			root, snapshot := t.TempDir(), t.TempDir()
			createRestoreDatabase(t, root,
				"PRAGMA user_version=3",
				"CREATE TABLE execution_barriers(id TEXT PRIMARY KEY,state TEXT NOT NULL,evidence TEXT NOT NULL)",
				"INSERT INTO execution_barriers VALUES('barrier-current','"+state+"','不能丢失的执行证据')",
				"CREATE TABLE workspace_versions(task_id TEXT PRIMARY KEY,revision INTEGER NOT NULL)",
				"INSERT INTO workspace_versions VALUES('task-current',7)",
			)
			agentFiles := []string{
				"config/agent-models.json", "config/agent-execution.json", "config/agent-skills.json",
				"config/agent-mcp.json", "config/agent-future.lock", "data/harness.sqlite.lock",
				"data/skills/skill/3/SKILL.md", "data/agent-workspaces/task-current.7.tar",
			}
			for _, name := range agentFiles {
				writeRestoreFixture(t, root, name, "当前修订")
				writeRestoreFixture(t, snapshot, name, "旧修订")
			}
			writeRestoreFixture(t, snapshot, "data/harness.sqlite", "旧数据库")
			writeRestoreFixture(t, snapshot, "config/agent-snapshot-only.json", "不应重新引入的配置")
			writeRestoreFixture(t, snapshot, "data/skills/removed/SKILL.md", "已移除的技能")
			writeRestoreFixture(t, root, "config/panel-network.json", "新端口")
			writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧端口")
			writeRestoreFixture(t, root, "data/websites/current.txt", "新网站数据")
			writeRestoreFixture(t, snapshot, "data/websites/current.txt", "旧网站数据")
			writeRestoreFixture(t, root, "state/panel-maintenance/task.json", "维护事务")
			before, err := os.ReadFile(filepath.Join(root, "data/harness.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			if err := restorePanelData(snapshot, root); err != nil {
				t.Fatal(err)
			}
			for _, name := range agentFiles {
				assertRestoreFixture(t, root, name, "当前修订")
			}
			after, err := os.ReadFile(filepath.Join(root, "data/harness.sqlite"))
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("当前运行库和执行证据被覆盖：%v", err)
			}
			for _, name := range []string{"config/agent-snapshot-only.json", "data/skills/removed/SKILL.md"} {
				if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
					t.Fatalf("旧备份不应重新引入 Agent 文件 %s：%v", name, err)
				}
			}
			assertRestoreFixture(t, root, "config/panel-network.json", "旧端口")
			assertRestoreFixture(t, root, "data/websites/current.txt", "旧网站数据")
			assertRestoreFixture(t, root, "state/panel-maintenance/task.json", "维护事务")
		})
	}
}

func TestMaintenancePreservesCompletedWorkflowAfterBarrierConfirmed(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	createRestoreDatabase(t, root, "PRAGMA user_version=4", "CREATE TABLE execution_barriers(state TEXT NOT NULL)", "INSERT INTO execution_barriers VALUES('confirmed')",
		"CREATE TABLE workflow_instances(id TEXT PRIMARY KEY,state TEXT NOT NULL)", "INSERT INTO workflow_instances VALUES('workflow-completed','succeeded')")
	writeRestoreFixture(t, root, "config/agent-models.json", "新修订")
	writeRestoreFixture(t, snapshot, "config/agent-models.json", "旧修订")
	createRestoreDatabase(t, snapshot, "PRAGMA user_version=2", "CREATE TABLE messages(content TEXT)", "INSERT INTO messages VALUES('备份时的事实')")
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	assertRestoreFixture(t, root, "config/agent-models.json", "新修订")
	db, err := sql.Open("sqlite", filepath.Join(root, "data/harness.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var state string
	if err := db.QueryRow("SELECT state FROM workflow_instances WHERE id='workflow-completed'").Scan(&state); err != nil || state != "succeeded" {
		t.Fatalf("已完成工作流回执不能随恢复倒退：%q %v", state, err)
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 4 {
		t.Fatalf("新数据库不能降级为备份版本：%d %v", version, err)
	}
	assertWorkflowRecoveryFence(t, root)
	if pending, err := preserveAgentFacts(root); err != nil || pending {
		t.Fatalf("保留当前 Agent 数据不应改变未决屏障判断：%t %v", pending, err)
	}
}

func assertWorkflowRecoveryFence(t *testing.T, root string) workflowRecoveryFence {
	t.Helper()
	path := WorkflowRecoveryFencePath(root)
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fence workflowRecoveryFence
	if err := json.Unmarshal(content, &fence); err != nil || fence.Version != 1 || fence.Reason != "panel-rollback" {
		t.Fatalf("恢复冻结标记无效：%s %v", content, err)
	}
	if _, err := time.Parse(time.RFC3339Nano, fence.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("恢复冻结标记必须是 0600：%v", err)
	}
	return fence
}

func TestMaintenanceRefusesSnapshotAgentDataWhenCurrentDatabaseMissing(t *testing.T) {
	for _, name := range []string{"data/harness.sqlite", "config/agent-models.json", "data/skills/package/SKILL.md"} {
		t.Run(name, func(t *testing.T) {
			root, snapshot := t.TempDir(), t.TempDir()
			writeRestoreFixture(t, snapshot, name, "备份中的 Agent 事实")
			writeRestoreFixture(t, root, "config/panel-network.json", "当前端口")
			writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧端口")
			if err := restorePanelData(snapshot, root); err == nil || !strings.Contains(err.Error(), "拒绝恢复") {
				t.Fatalf("当前运行库缺失时不能载入旧 Agent 数据：%v", err)
			}
			assertRestoreFixture(t, root, "config/panel-network.json", "当前端口")
		})
	}
}

func TestMaintenanceWithoutAgentDataRestoresNormally(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	writeRestoreFixture(t, root, "config/panel-network.json", "当前端口")
	writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧端口")
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	assertRestoreFixture(t, root, "config/panel-network.json", "旧端口")
	if _, err := os.Stat(WorkflowRecoveryFencePath(root)); !os.IsNotExist(err) {
		t.Fatalf("没有 Agent 数据不需要冻结标记：%v", err)
	}
}

func TestMaintenanceRepeatedRestoreRetainsWorkflowRecoveryFence(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	createRestoreDatabase(t, root, "PRAGMA user_version=4", "CREATE TABLE execution_barriers(state TEXT NOT NULL)",
		"CREATE TABLE workflow_instances(state TEXT NOT NULL)", "INSERT INTO workflow_instances VALUES('running')")
	writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧端口")
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	first := assertWorkflowRecoveryFence(t, root)
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	if next := assertWorkflowRecoveryFence(t, root); next != first {
		t.Fatalf("重复恢复必须保留原冻结标记：%+v %+v", first, next)
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "data/harness.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var state string
	if err := db.QueryRow("SELECT state FROM workflow_instances").Scan(&state); err != nil || state != "running" {
		t.Fatalf("维护进程不能直接改写工作流，由运行内核消费冻结标记：%s %v", state, err)
	}
}

func TestMaintenanceInvalidRecoveryFenceStopsBeforeRestore(t *testing.T) {
	fixtures := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{"损坏标记", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "state/panel-maintenance/agent-workflow-recovery.json", "损坏标记")
		}},
		{"错误权限", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "state/panel-maintenance/agent-workflow-recovery.json", `{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`)
			if err := os.Chmod(WorkflowRecoveryFencePath(root), 0644); err != nil {
				t.Fatal(err)
			}
		}},
		{"标记符号链接", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "state/panel-maintenance/other.json", "其他文件")
			if err := os.Symlink("other.json", WorkflowRecoveryFencePath(root)); err != nil {
				t.Fatal(err)
			}
		}},
		{"标记目录无法写入", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "state/panel-maintenance", "普通文件")
		}},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			root, snapshot := t.TempDir(), t.TempDir()
			createRestoreDatabase(t, root, "PRAGMA user_version=4", "CREATE TABLE execution_barriers(state TEXT NOT NULL)")
			fixture.setup(t, root)
			writeRestoreFixture(t, root, "config/panel-network.json", "当前端口")
			writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧端口")
			if err := restorePanelData(snapshot, root); err == nil || !strings.Contains(err.Error(), "拒绝恢复") {
				t.Fatalf("无法保证冻结标记时不能开始恢复：%v", err)
			}
			assertRestoreFixture(t, root, "config/panel-network.json", "当前端口")
		})
	}
}

func TestMaintenanceRefusesRestoreWhenBarrierCannotBeDetermined(t *testing.T) {
	fixtures := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{"损坏数据库", func(t *testing.T, root string) { writeRestoreFixture(t, root, "data/harness.sqlite", "损坏数据") }},
		{"新schema缺少屏障表", func(t *testing.T, root string) {
			createRestoreDatabase(t, root, "PRAGMA user_version=3", "CREATE TABLE runs(id TEXT)")
		}},
		{"屏障表缺少状态", func(t *testing.T, root string) {
			createRestoreDatabase(t, root, "PRAGMA user_version=3", "CREATE TABLE execution_barriers(id TEXT)")
		}},
		{"未知schema", func(t *testing.T, root string) { createRestoreDatabase(t, root, "CREATE TABLE runs(id TEXT)") }},
		{"孤立WAL", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "data/harness.sqlite-wal", "未落盘事实")
		}},
		{"数据库符号链接", func(t *testing.T, root string) {
			writeRestoreFixture(t, root, "data/other.sqlite", "不允许链接")
			if err := os.Symlink("other.sqlite", filepath.Join(root, "data/harness.sqlite")); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			root, snapshot := t.TempDir(), t.TempDir()
			fixture.setup(t, root)
			writeRestoreFixture(t, root, "config/panel-network.json", "当前配置")
			writeRestoreFixture(t, snapshot, "config/panel-network.json", "旧配置")
			if err := restorePanelData(snapshot, root); err == nil || !strings.Contains(err.Error(), "拒绝恢复") {
				t.Fatalf("无法确认屏障时必须拒绝恢复：%v", err)
			}
			assertRestoreFixture(t, root, "config/panel-network.json", "当前配置")
		})
	}
}

func TestMaintenanceRestoreFailureLeavesPendingAgentFactsInPlace(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	createRestoreDatabase(t, root, "PRAGMA user_version=3", "CREATE TABLE execution_barriers(state TEXT NOT NULL)", "INSERT INTO execution_barriers VALUES('unknown')")
	writeRestoreFixture(t, root, "config/agent-models.json", "当前修订")
	writeRestoreFixture(t, root, "data/agent-workspaces/task.7.tar", "当前工作区")
	writeRestoreFixture(t, snapshot, "data/other.txt", "原文件")
	if err := os.Symlink("other.txt", filepath.Join(snapshot, "data/link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := restorePanelData(snapshot, root); err == nil {
		t.Fatal("包含符号链接的备份应该失败")
	}
	assertRestoreFixture(t, root, "config/agent-models.json", "当前修订")
	assertRestoreFixture(t, root, "data/agent-workspaces/task.7.tar", "当前工作区")
	if preserve, err := preserveAgentFacts(root); err != nil || !preserve {
		t.Fatalf("失败后未决执行屏障必须仍然有效：%v", err)
	}
	assertWorkflowRecoveryFence(t, root)
}
