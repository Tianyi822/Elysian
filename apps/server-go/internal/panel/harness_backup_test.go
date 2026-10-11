package panel

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"elysian/server/internal/agent/harness/model"

	_ "modernc.org/sqlite"
)

type harnessSnapshotHost struct {
	*fakeHost
	stopDatabase func() error
}

func (h *harnessSnapshotHost) Stop(ctx context.Context) error {
	if err := h.fakeHost.Stop(ctx); err != nil {
		return err
	}
	return h.stopDatabase()
}

func TestMaintenanceBacksUpHarnessDatabaseAfterServiceStops(t *testing.T) {
	w, record, host := setupWorker(t, "ports")
	path := filepath.Join(w.Store.Root, "data", "harness.sqlite")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"CREATE TABLE runs(id TEXT PRIMARY KEY, state TEXT NOT NULL)",
		"INSERT INTO runs(id,state) VALUES('run-before-maintenance','running')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if info, err := os.Stat(path + "-wal"); err != nil || info.Size() == 0 {
		t.Fatalf("测试必须覆盖尚未关库的 WAL：%v", err)
	}
	w.Host = &harnessSnapshotHost{fakeHost: host, stopDatabase: func() error {
		// 模拟面板 Close 在进程退出前落盘的终态；提前复制会只拿到 running。
		if _, err := db.Exec("UPDATE runs SET state='interrupted' WHERE id='run-before-maintenance'"); err != nil {
			return err
		}
		return db.Close()
	}}
	if err := w.execute(context.Background(), &record); err != nil {
		t.Fatal(err)
	}
	if host.stops != 1 || !record.SnapshotReady {
		t.Fatalf("维护没有在停服后生成快照：%d %+v", host.stops, record)
	}
	snapshot := filepath.Join(record.Snapshot, "data", "harness.sqlite")
	check, err := sql.Open("sqlite", snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var state string
	if err := check.QueryRow("SELECT state FROM runs WHERE id='run-before-maintenance'").Scan(&state); err != nil {
		t.Fatalf("维护快照缺少任务库：%v", err)
	}
	if state != "interrupted" {
		t.Fatalf("快照未包含停服收尾的最终事实：%s", state)
	}
	var integrity string
	if err := check.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("任务库快照不完整：%s %v", integrity, err)
	}
}

func TestMaintenancePreservesCurrentAgentSessionsMemoryAndModelRevisions(t *testing.T) {
	w, record, host := setupWorker(t, "ports")
	modelPath := filepath.Join(w.Store.Root, "config", "agent", "models.json")
	profiles, err := model.Open(modelPath)
	if err != nil {
		t.Fatal(err)
	}
	secret := "backup-test-credential"
	input := model.Input{Name: "备份测试模型", BaseURL: "http://127.0.0.1:1/v1", Model: "fixture-model", ContextTokens: 8192, OutputTokens: 1024, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "manual"}, Credential: &secret, Active: true}
	created, err := profiles.Create(input)
	if err != nil {
		t.Fatal(err)
	}
	input.Name, input.Credential = "备份测试模型第二版", nil
	if _, err := profiles.Update(created.ID, 1, input); err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(w.Store.Root, "data", "harness.sqlite")
	if err := os.MkdirAll(filepath.Dir(databasePath), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	// 维护复制不解释业务 schema；此 fixture 覆盖跨文件模型引用与 WAL 内的会话事实。
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"CREATE TABLE sessions(id TEXT PRIMARY KEY, model_profile_id TEXT NOT NULL, model_revision INTEGER NOT NULL)",
		"CREATE TABLE messages(session_id TEXT NOT NULL, seq INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(session_id,seq))",
		"CREATE TABLE working_memory(task_id TEXT NOT NULL, revision INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(task_id,revision))",
		"INSERT INTO messages VALUES('session-backup',1,'用户输入原文')",
		"INSERT INTO working_memory VALUES('task-backup',1,'已确认的任务事实')",
		"PRAGMA user_version=2",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO sessions VALUES('session-backup',?,1)", created.ID); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixture(t, w.Store.Root, "data/agent-records/sessions/session-backup.jsonl", `{"seq":"1","kind":"message"}`+"\n")
	w.Host = &harnessSnapshotHost{fakeHost: host, stopDatabase: func() error {
		if _, err := db.Exec("INSERT INTO messages VALUES('session-backup',2,'停服收尾后的公开答复')"); err != nil {
			return err
		}
		return db.Close()
	}}
	if err := w.execute(context.Background(), &record); err != nil {
		t.Fatal(err)
	}
	if !record.SnapshotReady || host.stops != 1 {
		t.Fatal("必须在停服后生成完整维护快照")
	}
	assertRestoreFixture(t, record.Snapshot, "data/agent-records/sessions/session-backup.jsonl", `{"seq":"1","kind":"message"}`+"\n")
	// 模拟候选版本继续产生模型修订与任务事实；旧快照不能倒退这些事实。
	input.Name = "候选版本模型第三版"
	if _, err := profiles.Update(created.ID, 2, input); err != nil {
		t.Fatal(err)
	}
	candidate, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := candidate.Exec("UPDATE working_memory SET summary='候选版本数据'"); err != nil {
		_ = candidate.Close()
		t.Fatal(err)
	}
	if err := candidate.Close(); err != nil {
		t.Fatal(err)
	}
	writeRestoreFixture(t, w.Store.Root, "data/agent-records/sessions/session-backup.jsonl", `{"seq":"2","kind":"message"}`+"\n")
	if err := restorePanelData(record.Snapshot, w.Store.Root); err != nil {
		t.Fatal(err)
	}
	assertRestoreFixture(t, w.Store.Root, "data/agent-records/sessions/session-backup.jsonl", `{"seq":"2","kind":"message"}`+"\n")
	restored, err := model.Open(modelPath)
	if err != nil {
		t.Fatal(err)
	}
	old, err := restored.Resolve(created.ID, 1, true)
	if err != nil || old.Credential != secret || len(restored.List()) != 1 || restored.List()[0].Revision != 3 {
		t.Fatal("当前模型凭据与不可变历史修订未保留")
	}
	if info, err := os.Stat(modelPath); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("恢复后模型凭据文件权限错误：%v", err)
	}
	check, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var profileID string
	var revision int
	if err := check.QueryRow("SELECT model_profile_id,model_revision FROM sessions WHERE id='session-backup'").Scan(&profileID, &revision); err != nil || profileID != created.ID || revision != 1 {
		t.Fatalf("会话选择的历史模型版本未恢复：%v", err)
	}
	var message, summary string
	if err := check.QueryRow("SELECT content FROM messages WHERE session_id='session-backup' AND seq=2").Scan(&message); err != nil || message != "停服收尾后的公开答复" {
		t.Fatalf("公开会话历史未包含停服收尾事实：%v", err)
	}
	if err := check.QueryRow("SELECT summary FROM working_memory WHERE task_id='task-backup' AND revision=1").Scan(&summary); err != nil || summary != "候选版本数据" {
		t.Fatalf("当前任务工作记忆未保留：%v", err)
	}
	var integrity string
	if err := check.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		t.Fatalf("恢复后的运行库不完整：%s %v", integrity, err)
	}
	assertWorkflowRecoveryFence(t, w.Store.Root)
}
