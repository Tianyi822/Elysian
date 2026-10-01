package logs

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

// writeShard 写一个分片文件（可选 gzip）。
func writeShard(t *testing.T, dir, name string, content string, gzipped bool) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	full := filepath.Join(dir, name)
	if !gzipped {
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("写分片失败：%v", err)
		}
		return full
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(content)); err != nil {
		t.Fatalf("gzip 写失败：%v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip 关闭失败：%v", err)
	}
	if err := os.WriteFile(full, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("写分片失败：%v", err)
	}
	return full
}

// 导入三类分片（含 .gz）、坏行跳过、非分片文件不动、重复导入幂等、成功分片被 unlink
// （logImport.bun.test.ts ①）。
func TestImportPlatformLogs(t *testing.T) {
	root := t.TempDir()
	store := openTestStore(t, nil)

	runtimeShard := writeShard(t, filepath.Join(root, "runtime"), "runtime-20260923T000000Z.jsonl",
		`{"at":"2026-09-23T00:00:01.000Z","seq":1,"level":"info","source":"server.lifecycle","message":"启动"}`+"\n"+
			`bad line`+"\n"+
			"\n", false)
	operationShard := writeShard(t, filepath.Join(root, "operation"), "operation-20260923T000000Z.jsonl",
		`{"at":"2026-09-23T00:00:01.000Z","seq":2,"category":"security","action":"修改 SSH 监听端口","target":"sshd","result":"success","httpStatus":200,"method":"PUT","path":"/api/security/ssh/port","summary":"端口 2222","actor":"evil"}`+"\n", false)
	loginShard := writeShard(t, filepath.Join(root, "login"), "login-20260923T000000Z.jsonl.gz",
		`{"at":"2026-09-23T00:00:01.000Z","seq":3,"ip":"127.0.0.1","location":"本机","userAgent":"UA","status":"success"}`+"\n", true)

	// 非分片文件（notes.txt、sshd.log、目录同名假分片、_1 后缀不合法）不动。
	notes := writeShard(t, filepath.Join(root, "runtime"), "notes.txt", "keep", false)
	sshd := writeShard(t, filepath.Join(root, "runtime"), "sshd.log", "keep", false)
	fakeDir := filepath.Join(root, "runtime", "runtime-20260923T000001Z.jsonl")
	if err := os.MkdirAll(fakeDir, 0o755); err != nil {
		t.Fatalf("建假分片目录失败：%v", err)
	}
	badSuffix := writeShard(t, filepath.Join(root, "runtime"), "runtime-20260923T000000Z_1.jsonl", "{}", false)

	ImportPlatformLogs(store, root)

	runtimePage, _ := store.QueryRuntime(logListQuery{})
	if len(runtimePage.Entries) != 1 || runtimePage.Entries[0].Message != "启动" {
		t.Errorf("runtime 导入不符（坏行与空行不计）：%+v", runtimePage.Entries)
	}
	operationPage, _ := store.QueryOperation(operationLogListQuery{})
	if len(operationPage.Entries) != 1 {
		t.Fatalf("operation 导入不符：%d", len(operationPage.Entries))
	}
	entry := operationPage.Entries[0]
	if entry.Action != "修改 SSH 监听端口" || entry.Target == nil || *entry.Target != "sshd" || entry.HTTPStatus == nil {
		t.Errorf("operation 字段不符：%+v", entry)
	}
	loginPage, _ := store.QueryLogin(loginLogListQuery{})
	if len(loginPage.Entries) != 1 || loginPage.Entries[0].IP != "127.0.0.1" {
		t.Errorf("login（.gz）导入不符：%+v", loginPage.Entries)
	}

	// 成功分片被 unlink；非分片与假分片原样不动。
	for _, shard := range []string{runtimeShard, operationShard, loginShard} {
		if _, err := os.Stat(shard); !os.IsNotExist(err) {
			t.Errorf("成功分片应被 unlink：%s（err=%v）", shard, err)
		}
	}
	for _, kept := range []string{notes, sshd, badSuffix} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("非分片文件不应被动：%s（err=%v）", kept, err)
		}
	}
	if _, err := os.Stat(fakeDir); err != nil {
		t.Errorf("目录同名假分片不应被动：%v", err)
	}

	// 重复导入幂等：重建同内容分片再导入，不产生重复行。
	writeShard(t, filepath.Join(root, "runtime"), "runtime-20260923T000000Z_2.jsonl",
		`{"at":"2026-09-23T00:00:01.000Z","seq":1,"level":"info","source":"server.lifecycle","message":"启动"}`+"\n", false)
	ImportPlatformLogs(store, root)
	runtimePage, _ = store.QueryRuntime(logListQuery{})
	if len(runtimePage.Entries) != 1 {
		t.Errorf("整行 sha256 + OR IGNORE 应幂等：%d", len(runtimePage.Entries))
	}
}

// 巨大分片行不触发「超限中止」：bytes 硬闸在逐字段截断之后判定，而 at 必须可解析、
// 其余字段都有上限——单条记录被字段上限压在 64 KiB 之下，超限中止分支因此是防御性
// 代码（TS 侧同样不可经公开路径触达，见 logStore.ts:341-343 的判定次序）。这里锚定
// 真实可达行为：超长 message 截断入库、分片照常 unlink。
func TestImportLongLineTruncatesNotAborts(t *testing.T) {
	root := t.TempDir()
	store := openTestStore(t, nil)
	hugeMessage := make([]byte, logRecordMaxBytes)
	for i := range hugeMessage {
		hugeMessage[i] = 'x'
	}
	content := `{"at":"2026-09-23T00:00:02.000Z","seq":2,"level":"info","source":"s","message":"` + string(hugeMessage) + `"}` + "\n"
	shard := writeShard(t, filepath.Join(root, "runtime"), "runtime-20260923T000000Z.jsonl", content, false)

	ImportPlatformLogs(store, root)
	page, _ := store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 1 {
		t.Fatalf("超长行应截断入库：%d", len(page.Entries))
	}
	if jsLength(page.Entries[0].Message) != logMessageMaxLength {
		t.Errorf("message 应截到上限：%d", jsLength(page.Entries[0].Message))
	}
	if _, err := os.Stat(shard); !os.IsNotExist(err) {
		t.Errorf("成功分片应被 unlink：%v", err)
	}
}

// 操作日志条目不含多余字段（actor 不落库）：响应形状的键集恰为十键。
func TestImportOperationEntryShape(t *testing.T) {
	root := t.TempDir()
	store := openTestStore(t, nil)
	writeShard(t, filepath.Join(root, "operation"), "operation-20260923T000000Z.jsonl",
		`{"at":"2026-09-23T00:00:01.000Z","seq":9,"category":"logs","action":"清空运行日志","target":null,"result":"success","httpStatus":null,"method":null,"path":null,"summary":"删除 1 条记录","actor":"root","extra":[1,2]}`+"\n", false)
	ImportPlatformLogs(store, root)
	page, _ := store.QueryOperation(operationLogListQuery{})
	if len(page.Entries) != 1 {
		t.Fatalf("导入条数：%d", len(page.Entries))
	}
	entry := page.Entries[0]
	if entry.Summary != "删除 1 条记录" || entry.Target != nil || entry.HTTPStatus != nil || entry.Method != nil || entry.Path != nil {
		t.Errorf("导入字段不符：%+v", entry)
	}
}

// 不可用 store 导入不删除分片（logImport.bun.test.ts ③）。
func TestImportKeepsShardsWhenStoreUnavailable(t *testing.T) {
	root := t.TempDir()
	store := newUnavailableLogStore()
	shard := writeShard(t, filepath.Join(root, "runtime"), "runtime-20260923T000000Z.jsonl",
		`{"at":"2026-09-23T00:00:01.000Z","seq":1,"level":"info","source":"s","message":"m"}`+"\n", false)

	ImportPlatformLogs(store, root)
	if _, err := os.Stat(shard); err != nil {
		t.Errorf("不可用 store 时分片应保留：%v", err)
	}
}

// 目录不存在即跳过、不创建目录（§5）。
func TestImportMissingDirSkipped(t *testing.T) {
	root := t.TempDir()
	store := openTestStore(t, nil)
	ImportPlatformLogs(store, filepath.Join(root, "platform"))
	if _, err := os.Stat(filepath.Join(root, "platform")); !os.IsNotExist(err) {
		t.Errorf("导入不得创建目录：%v", err)
	}
	page, _ := store.QueryRuntime(logListQuery{})
	if len(page.Entries) != 0 {
		t.Errorf("不应有导入：%d", len(page.Entries))
	}
}
