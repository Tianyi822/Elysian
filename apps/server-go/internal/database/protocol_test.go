package database

import (
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

// databaseProtocol.test.ts 对等测试：Redis 黑名单、授权白名单矩阵与
// SQL 终端黑名单（带字符串态的注释归一）。

func expectInvalidRequest(t *testing.T, err error, status int, contains string) {
	t.Helper()
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("应抛 InvalidRequestError(%d %s)，实际 %v", status, contains, err)
	}
	if invalid.Status != status || !strings.Contains(invalid.Message, contains) {
		t.Fatalf("应抛 InvalidRequestError(%d %s…)，实际 (%d %s)", status, contains, invalid.Status, invalid.Message)
	}
}

func expectPass(t *testing.T, err error, context string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s 不应被拒，实际 %v", context, err)
	}
}

func TestValidateRedisTerminalCommand(t *testing.T) {
	for _, command := range []string{
		"CONFIG SET dir /tmp", `EVAL "return 1" 0`, `EVAL_RO "return 1" 0`, "SELECT 1",
		"MOVE key 1", "COPY key dst DB 1", "FLUSHDB", "ACL SETUSER x", "MODULE LOAD x",
		"MIGRATE host 1 k 0 1",
	} {
		if _, err := validateRedisTerminalCommand(command); err == nil {
			t.Fatalf("命令 %q 应被拒绝", command)
		}
	}
	args, err := validateRedisTerminalCommand(`SET "my key" value`)
	if err != nil {
		t.Fatalf("SET 引号分词不应被拒：%v", err)
	}
	if len(args) != 3 || args[0] != "SET" || args[1] != "my key" || args[2] != "value" {
		t.Fatalf("SET 分词结果不符：%v", args)
	}
	if _, err := validateRedisTerminalCommand("GET " + strings.Repeat("x", 70_000)); err == nil {
		t.Fatal("超 64 KiB 命令应被拒绝")
	} else {
		expectInvalidRequest(t, err, 400, "64 KiB")
	}
	if _, err := validateRedisTerminalCommand("   "); err == nil {
		t.Fatal("空命令应被拒绝")
	}
}

func grantRowsWithin(patch func(*sqlGrantRows)) sqlGrantRows {
	rows := sqlGrantRows{
		UserPrivileges: []sqlGrantRow{{PrivilegeType: "USAGE", IsGrantable: "NO"}},
	}
	if patch != nil {
		patch(&rows)
	}
	return rows
}

func TestAssertSqlGrantsWithinDatabase(t *testing.T) {
	t.Run("表级与列级其他库授权必须拒绝", func(t *testing.T) {
		err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.TablePrivileges = []sqlGrantRow{{TableSchema: "otherdb", IsGrantable: "NO"}}
		}))
		expectInvalidRequest(t, err, 403, "其他数据库")
		err = assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.ColumnPrivileges = []sqlGrantRow{{TableSchema: "otherdb", IsGrantable: "NO"}}
		}))
		expectInvalidRequest(t, err, 403, "其他数据库")
	})

	t.Run("通配库名授权必须拒绝", func(t *testing.T) {
		for _, schema := range []string{"app%", "%"} {
			err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
				rows.SchemaPrivileges = []sqlGrantRow{{TableSchema: schema, IsGrantable: "NO"}}
			}))
			expectInvalidRequest(t, err, 403, "其他数据库")
		}
	})

	t.Run("USAGE 之外的全局授权必须拒绝", func(t *testing.T) {
		for _, privilege := range []string{"FILE", "SUPER", "SELECT"} {
			err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
				rows.UserPrivileges = []sqlGrantRow{{PrivilegeType: privilege, IsGrantable: "NO"}}
			}))
			expectInvalidRequest(t, err, 403, "全局权限")
		}
	})

	t.Run("IS_GRANTABLE=YES（GRANT OPTION）必须拒绝", func(t *testing.T) {
		err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.SchemaPrivileges = []sqlGrantRow{{TableSchema: "appdb", IsGrantable: "YES"}}
		}))
		expectInvalidRequest(t, err, 403, "超出目标数据库")
		err = assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.UserPrivileges = []sqlGrantRow{{PrivilegeType: "USAGE", IsGrantable: "YES"}}
		}))
		expectInvalidRequest(t, err, 403, "超出目标数据库")
	})

	t.Run("仅目标库授权放行", func(t *testing.T) {
		var schemaRows []sqlGrantRow
		for _, privilege := range []string{"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "INDEX", "REFERENCES", "CREATE VIEW", "SHOW VIEW", "TRIGGER"} {
			schemaRows = append(schemaRows, sqlGrantRow{TableSchema: "appdb", IsGrantable: "NO"})
			_ = privilege
		}
		expectPass(t, assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.SchemaPrivileges = schemaRows
		})), "单库 GRANT")
	})

	t.Run("可适用角色非空必须拒绝", func(t *testing.T) {
		err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.ApplicableRoles = []sqlGrantRow{{PrivilegeType: "high_priv_role", IsGrantable: "NO"}}
		}))
		expectInvalidRequest(t, err, 403, "角色")
	})

	t.Run("例程授权越库或带 GRANT OPTION 必须拒绝", func(t *testing.T) {
		err := assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.RoutinePrivileges = []sqlGrantRow{{TableSchema: "otherdb", IsGrantable: "NO"}}
		}))
		expectInvalidRequest(t, err, 403, "其他数据库")
		err = assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.RoutinePrivileges = []sqlGrantRow{{TableSchema: "appdb", IsGrantable: "YES"}}
		}))
		expectInvalidRequest(t, err, 403, "超出目标数据库")
	})

	t.Run("无可适用角色且例程授权落在目标库内放行", func(t *testing.T) {
		expectPass(t, assertSqlGrantsWithinDatabase("appdb", grantRowsWithin(func(rows *sqlGrantRows) {
			rows.RoutinePrivileges = []sqlGrantRow{{TableSchema: "appdb", IsGrantable: "NO"}}
		})), "例程授权在库内")
	})
}

func TestValidateSqlTerminalStatement(t *testing.T) {
	t.Run("字符串里的 # 与 -- 不是注释起点，其后禁词照常拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement(`select '#', load_file("/etc/passwd")`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`select 'a-- ', load_file("/etc/passwd")`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`select "#", load_file('/etc/passwd')`), 403, "禁止")
	})

	t.Run("注释分隔的禁词必须拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("USE/**/otherdb"), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement("SET /*x*/GLOBAL x=1"), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`select load_file /*x*/ ("/etc/passwd")`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`CREATE /*x*/FUNCTION f RETURNS int SONAME 'x.so'`), 403, "禁止")
	})

	t.Run("原有禁词形态保持拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement(`LOAD DATA LOCAL INFILE '/etc/passwd' INTO t`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`SELECT * FROM t INTO OUTFILE '/tmp/x'`), 403, "禁止")
	})

	t.Run("无空格 -- 是双减号运算符而非注释", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement(`SELECT 1--load_file('/etc/passwd')`), 403, "禁止")
	})

	t.Run("MySQL 版本执行注释内代码照常拦截，未闭合按 400", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement(`/*!40000 SELECT load_file('/etc/passwd') */`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`/*! USE otherdb */`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement(`/*! SET GLOBAL x=1 */`), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement("SELECT /*! x"), 400, "注释未闭合")
	})

	t.Run("USE 反引号紧贴的跨库切换必须拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("USE`otherdb`"), 403, "禁止")
	})

	t.Run("SET @@GLOBAL 与 SET @@SESSION 变量地址形态必须拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("SET @@GLOBAL.max_connections=1"), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement("SET @@SESSION.sql_mode=1"), 403, "禁止")
	})

	t.Run("SET ROLE 与 SET DEFAULT ROLE 必须拦截", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("SET ROLE r"), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement("SET DEFAULT ROLE ALL TO u"), 403, "禁止")
	})

	t.Run("跨库 CALL 拦截，本库 CALL 放行", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("CALL otherdb.p()"), 403, "禁止")
		expectInvalidRequest(t, validateSqlTerminalStatement("CALL `otherdb`.p()"), 403, "禁止")
		expectPass(t, validateSqlTerminalStatement("CALL p()"), "本库 CALL")
	})

	t.Run("回归：-- 行注释、普通块注释、中文注释不误伤", func(t *testing.T) {
		expectPass(t, validateSqlTerminalStatement("SELECT 1 -- USE otherdb"), "-- 行注释")
		expectPass(t, validateSqlTerminalStatement("SELECT /* USE otherdb */ 1"), "普通块注释")
		expectPass(t, validateSqlTerminalStatement("SELECT 1 -- 注释"), "中文注释")
	})

	t.Run("正常语句放行，字符串内的注释字符与转义不误伤", func(t *testing.T) {
		for _, sqlText := range []string{
			"SELECT 1", "SELECT * FROM t /* 正常 */", `SELECT "a#b", 1`, `SELECT 'it''s', 'a\'b\''`,
		} {
			expectPass(t, validateSqlTerminalStatement(sqlText), sqlText)
		}
	})

	t.Run("未闭合块注释按 400 拒绝，超过 64 KiB 拒绝", func(t *testing.T) {
		expectInvalidRequest(t, validateSqlTerminalStatement("SELECT /* x"), 400, "注释未闭合")
		err := validateSqlTerminalStatement("SELECT " + strings.Repeat("x", 70_000))
		if err == nil || !strings.Contains(err.Error(), "64 KiB") {
			t.Fatalf("超长语句应提示 64 KiB，实际 %v", err)
		}
	})
}

func TestAccessScopeFromInspect(t *testing.T) {
	inspectWithBinding := func(hostIP string) map[string]any {
		return map[string]any{
			"HostConfig": map[string]any{
				"PortBindings": map[string]any{
					"3306/tcp": []any{map[string]any{"HostIp": hostIP}},
				},
			},
		}
	}
	if got := accessScopeFromInspect(inspectWithBinding("0.0.0.0"), engineMySQL); got != scopeAnyHost {
		t.Fatalf("HostIp 0.0.0.0 应为 any-host，实际 %s", got)
	}
	if got := accessScopeFromInspect(inspectWithBinding("::"), engineMySQL); got != scopeAnyHost {
		t.Fatalf("HostIp :: 应为 any-host，实际 %s", got)
	}
	if got := accessScopeFromInspect(inspectWithBinding(""), engineMySQL); got != scopeAnyHost {
		t.Fatalf("HostIp 空应为 any-host，实际 %s", got)
	}
	if got := accessScopeFromInspect(inspectWithBinding("127.0.0.1"), engineMySQL); got != scopeLocalhost {
		t.Fatalf("HostIp 127.0.0.1 应为 localhost，实际 %s", got)
	}
	if got := accessScopeFromInspect(inspectWithBinding("::1"), engineMySQL); got != scopeLocalhost {
		t.Fatalf("HostIp ::1 应为 localhost，实际 %s", got)
	}
	if got := accessScopeFromInspect(map[string]any{"HostConfig": map[string]any{}}, engineMySQL); got != scopeContainerNet {
		t.Fatalf("无绑定应为 container-network，实际 %s", got)
	}
}

func TestActualVersionMatches(t *testing.T) {
	if !actualVersionMatches("8.4", "8.4") || !actualVersionMatches("8.4", "8.4.7") || !actualVersionMatches("8.4", "8.4-rc1") {
		t.Fatal("tag 与 tag./tag- 前缀应匹配")
	}
	if actualVersionMatches("8.4", "8.40") {
		t.Fatal("8.40 不应匹配 8.4")
	}
}
