package database

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/shared"
)

// sqliteService.bun.test.ts 对等测试（真子进程）：生命周期、上传校验、快照并发
// 与 fs 错误分类。worker 经测试二进制自身分叉（TestMain 拦截，go-plan §11 D10）。

// TestMain 兼任 SQLite worker 子进程入口：父进程注入 ELYSIAN_SQLITE_FILE 时
// 跳过测试框架直接进入 IPC 主循环。
func TestMain(m *testing.M) {
	if os.Getenv("ELYSIAN_SQLITE_FILE") != "" {
		os.Exit(RunSQLiteWorker(os.Stdin, os.Stdout, os.Getenv))
	}
	os.Exit(m.Run())
}

func newTestSqliteService(t *testing.T, mutate func(*sqliteOptions)) *sqliteService {
	t.Helper()
	workspace := t.TempDir()
	options := sqliteOptions{
		DataDir:      workspace + "/data/sqlite",
		RegistryPath: workspace + "/config/sqlite-databases.json",
		Launcher: func() sqliteWorkerCommand {
			return sqliteWorkerCommand{Path: os.Args[0], Args: []string{"-test.run=TestMain"}}
		},
		Now: func() time.Time { return time.Unix(0, 0).UTC() },
	}
	if mutate != nil {
		mutate(&options)
	}
	return newSqliteService(options)
}

func TestSqliteLifecycle(t *testing.T) {
	service := newTestSqliteService(t, nil)
	created, err := service.Create(context.Background(), "notes")
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	if created.ID == "" || !strings.HasPrefix(created.ID, "sqlite-") {
		t.Fatalf("SQLite 实例 id 应带 sqlite- 前缀：%s", created.ID)
	}
	if created.Status != statusRunning || created.Source != sourceManaged {
		t.Fatalf("创建后应为 running/managed：%+v", created)
	}
	// 终端会话：建表、插入、查询、ATTACH 拒。
	session, err := service.OpenSession(context.Background(), strings.TrimPrefix(created.ID, "sqlite-"))
	if err != nil {
		t.Fatalf("openSession 失败：%v", err)
	}
	if _, err := session.Execute(context.Background(), "CREATE TABLE notes (id INTEGER, value TEXT)"); err != nil {
		t.Fatalf("建表失败：%v", err)
	}
	lines, err := session.Execute(context.Background(), "INSERT INTO notes VALUES (1, 'hello')")
	if err != nil {
		t.Fatalf("插入失败：%v", err)
	}
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "执行成功，影响") {
		t.Fatalf("插入回显应为「执行成功，影响 N 行。」：%v", lines)
	}
	rows, err := session.Execute(context.Background(), "SELECT id, value FROM notes")
	if err != nil {
		t.Fatalf("查询失败：%v", err)
	}
	if len(rows) != 3 || rows[0] != "id\tvalue" || rows[1] != "1\thello" || !strings.Contains(rows[2], "返回 1 行。") {
		t.Fatalf("查询输出不符：%#v", rows)
	}
	// ATTACH 被策略拒绝；错误经 IPC 帧回传文本（TS 同构：status 不随帧回传）。
	_, attachErr := session.Execute(context.Background(), "ATTACH '/etc/passwd' AS other")
	if attachErr == nil || !strings.Contains(attachErr.Error(), "禁止文件") {
		t.Fatalf("ATTACH 应被拒且消息含「禁止文件」，实际 %v", attachErr)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	// 快照下载字节 > 0。
	snapshot, err := service.Download(context.Background(), strings.TrimPrefix(created.ID, "sqlite-"))
	if err != nil {
		t.Fatalf("download 失败：%v", err)
	}
	if snapshot.Bytes <= 0 || snapshot.Name != "notes.db" {
		t.Fatalf("快照不符：%+v", snapshot)
	}
	data, readErr := os.ReadFile(snapshot.Path)
	if readErr != nil || len(data) != int(snapshot.Bytes) {
		t.Fatalf("快照文件应可读且长度一致：%v", readErr)
	}
	snapshot.Cleanup()
	if _, statErr := os.Stat(snapshot.Path); !os.IsNotExist(statErr) {
		t.Fatal("cleanup 后快照应删除")
	}
	// remove 后只剩登记消失、文件清理。
	if err := service.Remove(context.Background(), strings.TrimPrefix(created.ID, "sqlite-")); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	rows2, err := service.List(context.Background())
	if err != nil || len(rows2) != 0 {
		t.Fatalf("remove 后列表应为空：%v %v", rows2, err)
	}
}

func TestSqliteUploadValidation(t *testing.T) {
	service := newTestSqliteService(t, nil)
	t.Run("全零文件拒「不是 SQLite」且登记可 forget", func(t *testing.T) {
		corrupt := make([]byte, 200)
		_, err := service.ImportFile(context.Background(), "corrupt", bytes.NewReader(corrupt), int64(len(corrupt)), "application/octet-stream")
		expectInvalidRequest(t, err, 400, "上传文件不是 SQLite 数据库")
		rows, listErr := service.records()
		if listErr != nil || len(rows) != 1 || rows[0].State != sqliteStatePending {
			t.Fatalf("失败后登记应留 pending：%+v %v", rows, listErr)
		}
		if err := service.Forget(context.Background(), rows[0].ID); err != nil {
			t.Fatalf("pending 登记应可 forget：%v", err)
		}
	})
	t.Run("WAL 头拒上传", func(t *testing.T) {
		wal := make([]byte, 200)
		copy(wal, "SQLite format 3\x00")
		wal[18] = 2
		_, err := service.ImportFile(context.Background(), "wal", bytes.NewReader(wal), int64(len(wal)), "application/octet-stream")
		expectInvalidRequest(t, err, 400, "WAL 数据库请先导出独立快照再上传")
	})
	t.Run("申报超限拒 256 MiB", func(t *testing.T) {
		_, err := service.ImportFile(context.Background(), "big", bytes.NewReader([]byte("x")), int64(256*1024*1024+1), "application/octet-stream")
		expectInvalidRequest(t, err, 413, "SQLite 文件超过 256 MiB")
	})
	t.Run("非 octet-stream 拒 415", func(t *testing.T) {
		_, err := service.ImportFile(context.Background(), "x", bytes.NewReader([]byte("x")), 1, "application/json")
		expectInvalidRequest(t, err, 415, "上传类型必须为 application/octet-stream")
	})
	t.Run("同名库大小写不敏感拒 409", func(t *testing.T) {
		if _, err := service.Create(context.Background(), "Same"); err != nil {
			t.Fatalf("首次创建失败：%v", err)
		}
		_, err := service.Create(context.Background(), "same")
		expectInvalidRequest(t, err, 409, "同名 SQLite 数据库已存在")
	})
	t.Run("空 reader 拒 400", func(t *testing.T) {
		_, err := service.ImportFile(context.Background(), "empty", bytes.NewReader(nil), 0, "application/octet-stream")
		if err == nil || !strings.Contains(err.Error(), "SQLite 文件为空或上传不完整") {
			t.Fatalf("空上传应拒绝，实际 %v", err)
		}
	})
}

// 从真实库导出一份合法 SQLite 字节流，供回灌测试。
func makeValidSqliteBytes(t *testing.T, service *sqliteService, name string) []byte {
	t.Helper()
	created, err := service.Create(context.Background(), name)
	if err != nil {
		t.Fatalf("建库失败：%v", err)
	}
	session, err := service.OpenSession(context.Background(), strings.TrimPrefix(created.ID, "sqlite-"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Execute(context.Background(), "CREATE TABLE notes (id INTEGER, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := session.Execute(context.Background(), "INSERT INTO notes VALUES (1, 'hello')"); err != nil {
		t.Fatal(err)
	}
	session.Close()
	snapshot, err := service.Download(context.Background(), strings.TrimPrefix(created.ID, "sqlite-"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(snapshot.Path)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Cleanup()
	if err := service.Remove(context.Background(), strings.TrimPrefix(created.ID, "sqlite-")); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSqliteImportRoundTrip(t *testing.T) {
	service := newTestSqliteService(t, nil)
	payload := makeValidSqliteBytes(t, service, "donor")
	imported, err := service.ImportFile(context.Background(), "copy", bytes.NewReader(payload), int64(len(payload)), "application/octet-stream")
	if err != nil {
		t.Fatalf("回灌失败：%v", err)
	}
	if imported.TableCount == nil || *imported.TableCount != 1 {
		t.Fatalf("回灌后 tableCount 应为 1：%+v", imported)
	}
}

func TestSqliteDownloadConcurrency(t *testing.T) {
	service := newTestSqliteService(t, nil)
	created, err := service.Create(context.Background(), "notes")
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimPrefix(created.ID, "sqlite-")
	first, err := service.Download(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Download(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Download(context.Background(), id)
	expectInvalidRequest(t, err, 503, "SQLite 快照导出并发已达上限，请稍后重试")
	first.Cleanup()
	first.Cleanup() // 重复 cleanup 不过度递减。
	third, err := service.Download(context.Background(), id)
	if err != nil {
		t.Fatalf("释放一个名额后应可再导出：%v", err)
	}
	third.Cleanup()
	second.Cleanup()
	// 404 路径释放名额。
	if _, err := service.Download(context.Background(), "00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("未知 id 应 404")
	}
	fourth, err := service.Download(context.Background(), id)
	if err != nil {
		t.Fatalf("404 路径应释放名额：%v", err)
	}
	fourth.Cleanup()
}

func TestSqliteFsMessageClassification(t *testing.T) {
	cases := map[string]string{
		"ENOENT": "SQLite 管理文件不存在",
		"EACCES": "SQLite 管理文件无法访问",
		"ENOSPC": "SQLite 管理空间不足",
		"ELOOP":  "SQLite 管理路径嵌套超限",
	}
	for code, expected := range cases {
		if message := sqliteFsMessage(&errnoError{code: code, message: "raw path /secret"}); message != expected {
			t.Fatalf("code %s 应分类为 %q，实际 %q", code, expected, message)
		}
	}
	if message := sqliteFsMessage(&errnoError{code: "EUNKNOWN", message: "x"}); message != "SQLite 管理文件不可用" {
		t.Fatalf("未识别 code 应兜底，实际 %q", message)
	}
	if message := sqliteFsMessage(errors.New("数据库终端消息")); message != "数据库终端消息" {
		t.Fatalf("无 code 的错误应原样，实际 %q", message)
	}
	if message := sqliteFsMessage(shared.InvalidRequest("请求错误")); message != "请求错误" {
		t.Fatalf("InvalidRequestError 应原样，实际 %q", message)
	}
	if message := sqliteFsMessage(nil); message != "SQLite 管理文件不可用" {
		t.Fatalf("nil 应兜底，实际 %q", message)
	}
}

func TestSqliteQuotaWithSmallTotalLimit(t *testing.T) {
	// totalLimit=8192（2 页）：limitBytes = max(自身字节, min(1GiB, 8192-其他))
	// —— 空库自身 ~12KB（3 页），因此写入超 3 页的数据被 max_page_count 拦截。
	service := newTestSqliteService(t, func(options *sqliteOptions) {
		options.TotalLimitBytes = 8192
	})
	created, err := service.Create(context.Background(), "notes")
	if err != nil {
		t.Fatalf("小配额建库失败：%v", err)
	}
	id := strings.TrimPrefix(created.ID, "sqlite-")
	session, err := service.OpenSession(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Execute(context.Background(), "CREATE TABLE notes (id INTEGER, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	_, insertErr := session.Execute(context.Background(), fmt.Sprintf("INSERT INTO notes VALUES (1, '%s')", strings.Repeat("x", 60000)))
	if insertErr == nil {
		t.Fatal("小配额下超限写入应被配额拦截")
	}
	session.Close()
	// 文件未超限：库仍可打开核对。
	rows, err := service.List(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("配额拦截不应破坏登记：%v %v", rows, err)
	}
	// 总量已达上限：再建新库 413。
	_, err = service.Create(context.Background(), "another")
	if err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("总量超限后再建应 413「上限」，实际 %v", err)
	}
}

func TestSqliteReconcileDeletingReturnsEmptyBody(t *testing.T) {
	service := newTestSqliteService(t, nil)
	created, err := service.Create(context.Background(), "notes")
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimPrefix(created.ID, "sqlite-")
	// 置 deleting 态模拟删除中断。
	rows, _ := service.records()
	rows[0].State = sqliteStateDeleting
	if err := service.save(rows); err != nil {
		t.Fatal(err)
	}
	_, hasBody, err := service.Reconcile(context.Background(), id)
	if err != nil {
		t.Fatalf("deleting 核对应完成清理：%v", err)
	}
	if hasBody {
		t.Fatal("deleting 清理路径应返回空主体（hasBody=false）")
	}
	rows, _ = service.records()
	if len(rows) != 0 {
		t.Fatalf("清理后登记应为空：%+v", rows)
	}
}

// 供 worker 子进程自举时防 vet 告警：io 与 errors 由其余测试使用。
var (
	_ io.Reader = (*bytes.Reader)(nil)
	_           = errors.New
)
