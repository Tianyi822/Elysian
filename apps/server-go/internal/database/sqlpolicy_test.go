package database

import (
	"strings"
	"testing"
)

// sqliteSqlPolicy.test.ts 对等测试：放行/拒绝矩阵。

func TestValidateSqliteStatementAllowed(t *testing.T) {
	for _, sqlText := range []string{
		"SELECT 1;", "WITH rows(x) AS (SELECT 1) SELECT x FROM rows",
		"INSERT INTO notes VALUES ('a;b')", "CREATE TABLE notes (id INTEGER, value TEXT)",
		"CREATE INDEX notes_id ON notes(id)", "ALTER TABLE notes ADD COLUMN extra TEXT",
		"BEGIN", "ROLLBACK", "SELECT\n  1 /* ; ATTACH */ + 2;",
		"PRAGMA page_size", "PRAGMA journal_mode",
		`SELECT "value" FROM "notes"`, `SELECT 'readfile'`, "SELECT `value` FROM [notes]",
		`SELECT "read""file"('/tmp/x')`,
	} {
		if err := validateSqliteStatement(sqlText); err != nil {
			t.Fatalf("语句 %q 应放行，实际 %v", sqlText, err)
		}
	}
}

func TestValidateSqliteStatementRejected(t *testing.T) {
	for _, sqlText := range []string{
		"PRAGMA journal_mode=WAL", "PRAGMA page_size=4096",
		"ATTACH DATABASE '/etc/passwd' AS other", "SELECT 1; DELETE FROM notes",
		"SELECT load_extension('/tmp/x')", "VACUUM INTO '/tmp/copy.db'",
		"PRAGMA writable_schema=ON", "PRAGMA user_version(5)",
		"CREATE VIRTUAL TABLE x USING fts5(value)", "CREATE TRIGGER x AFTER INSERT ON notes BEGIN SELECT 1; END",
		"SELECT 1; /* comment */ DELETE FROM notes",
		`SELECT "readfile"("/etc/passwd")`,
		`SELECT "load_extension"("/tmp/x.so")`,
		`CREATE "VIRTUAL" TABLE x USING fts5(v)`,
		"SELECT [writefile]('/tmp/x')",
		"SELECT `load_extension`(\"/tmp/x.so\")",
	} {
		if err := validateSqliteStatement(sqlText); err == nil {
			t.Fatalf("语句 %q 应被拒绝", sqlText)
		}
	}
}

func TestValidateSqliteStatementEdgeMessages(t *testing.T) {
	if err := validateSqliteStatement("   "); err == nil || !strings.Contains(err.Error(), "请输入 SQL 语句") {
		t.Fatalf("空语句应 400「请输入 SQL 语句」，实际 %v", err)
	}
	err := validateSqliteStatement("SELECT " + strings.Repeat("x", 70_000))
	if err == nil || !strings.Contains(err.Error(), "SQL 超过 64 KiB") {
		t.Fatalf("超长应 413「SQL 超过 64 KiB」，实际 %v", err)
	}
	if err = validateSqliteStatement("SELECT /* x"); err == nil || !strings.Contains(err.Error(), "SQL 注释未闭合") {
		t.Fatalf("未闭合块注释应 400，实际 %v", err)
	}
	if err = validateSqliteStatement("SELECT 'x"); err == nil || !strings.Contains(err.Error(), "SQL 引号未闭合") {
		t.Fatalf("未闭合引号应 400，实际 %v", err)
	}
	if err = validateSqliteStatement("SELECT 1; SELECT 2"); err == nil || !strings.Contains(err.Error(), "一次只能执行一条 SQL") {
		t.Fatalf("多语句应 403，实际 %v", err)
	}
	if err = validateSqliteStatement(";"); err == nil || !strings.Contains(err.Error(), "一次只能执行一条 SQL") {
		t.Fatalf("仅分号应 403，实际 %v", err)
	}
}
