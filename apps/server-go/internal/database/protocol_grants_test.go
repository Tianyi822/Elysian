package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"testing"
)

type grantTestQuery func(string, []driver.NamedValue) (driver.Rows, error)
type grantTestConnector struct{ query grantTestQuery }
type grantTestDriver struct{}
type grantTestConn struct{ query grantTestQuery }
type grantTestRows struct {
	columns []string
	values  [][]driver.Value
}

func (c grantTestConnector) Connect(context.Context) (driver.Conn, error) {
	return grantTestConn{query: c.query}, nil
}
func (grantTestConnector) Driver() driver.Driver { return grantTestDriver{} }
func (grantTestDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("测试连接只能通过 connector 创建")
}
func (grantTestConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (grantTestConn) Close() error                        { return nil }
func (grantTestConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (c grantTestConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.query(query, args)
}
func (r *grantTestRows) Columns() []string { return r.columns }
func (r *grantTestRows) Close() error      { return nil }
func (r *grantTestRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}
func grantTestDB(t *testing.T, query grantTestQuery) *sql.DB {
	t.Helper()
	db := sql.OpenDB(grantTestConnector{query: query})
	t.Cleanup(func() { _ = db.Close() })
	return db
}
func grantIdentityDB(t *testing.T, account string) *sql.DB {
	t.Helper()
	return grantTestDB(t, func(query string, args []driver.NamedValue) (driver.Rows, error) {
		if query != "SELECT CURRENT_USER()" || len(args) != 0 {
			t.Fatalf("实际账号必须由普通连接查询，实际 %s", query)
		}
		return &grantTestRows{columns: []string{"CURRENT_USER()"}, values: [][]driver.Value{{account}}}, nil
	})
}

func TestRoutineGrantsUseAuthenticatedAccountAndPreserveBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, schema, grantable, rejected string
	}{
		{"目标库例程", "appdb", "NO", ""},
		{"其他库例程", "otherdb", "NO", "其他数据库"},
		{"例程转授权", "appdb", "YES", "超出目标数据库"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			user := grantIdentityDB(t, "ordinary@localhost")
			admin := grantTestDB(t, func(query string, args []driver.NamedValue) (driver.Rows, error) {
				if !strings.Contains(query, "FROM mysql.procs_priv") || !strings.Contains(query, "FIND_IN_SET('Grant', Proc_priv)") {
					t.Fatalf("例程核验必须读取实际授权表并保留转授权事实：%s", query)
				}
				if len(args) != 2 || args[0].Value != "ordinary" || args[1].Value != "localhost" {
					t.Fatalf("必须绑定实际账号 Host，不可猜测 %%：%v", args)
				}
				return &grantTestRows{columns: []string{"TABLE_SCHEMA", "IS_GRANTABLE"}, values: [][]driver.Value{{tc.schema, tc.grantable}}}, nil
			})
			rows, err := queryRoutineGrantRows(context.Background(), admin, user, "ordinary")
			if err != nil {
				t.Fatal(err)
			}
			err = assertSqlGrantsWithinDatabase("appdb", sqlGrantRows{RoutinePrivileges: rows})
			if tc.rejected == "" {
				expectPass(t, err, tc.name)
			} else {
				expectInvalidRequest(t, err, 403, tc.rejected)
			}
		})
	}
}

func TestRoutineGrantQueryFailureAndIdentityMismatchRemainRejected(t *testing.T) {
	denied := errors.New("测试管理员无读取权限")
	calls := 0
	admin := grantTestDB(t, func(string, []driver.NamedValue) (driver.Rows, error) {
		calls++
		return nil, denied
	})
	for _, account := range []string{"anonymous@localhost", "ordinary", "ordinary@"} {
		_, err := queryRoutineGrantRows(context.Background(), admin, grantIdentityDB(t, account), "ordinary")
		expectInvalidRequest(t, err, 403, "身份")
	}
	if calls != 0 {
		t.Fatal("身份不一致时不可查询另一账号的授权")
	}
	_, err := queryRoutineGrantRows(context.Background(), admin, grantIdentityDB(t, "ordinary@%"), "ordinary")
	if !errors.Is(err, denied) {
		t.Fatalf("读取失败不可当作没有例程授权：%v", err)
	}
}

func TestGrantRowsDecodeSQLTextAndRejectMissingFacts(t *testing.T) {
	for _, tc := range []struct {
		name    string
		values  []driver.Value
		missing bool
	}{
		{"驱动字节", []driver.Value{[]byte("USAGE"), []byte("NO"), []byte("appdb")}, false},
		{"驱动字符串", []driver.Value{"USAGE", "NO", "appdb"}, false},
		{"缺失权限", []driver.Value{nil, "NO", "appdb"}, true},
		{"缺失转授权事实", []driver.Value{"USAGE", nil, "appdb"}, true},
		{"缺失库范围", []driver.Value{"USAGE", "NO", nil}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := grantTestDB(t, func(string, []driver.NamedValue) (driver.Rows, error) {
				return &grantTestRows{columns: []string{"PRIVILEGE_TYPE", "IS_GRANTABLE", "TABLE_SCHEMA"}, values: [][]driver.Value{tc.values}}, nil
			})
			rows, err := queryGrantRows(context.Background(), db, "SELECT 授权事实")
			if tc.missing {
				if err == nil {
					t.Fatal("缺失授权事实不能当作没有越界权限")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 1 || rows[0].PrivilegeType != "USAGE" || rows[0].IsGrantable != "NO" || rows[0].TableSchema != "appdb" {
				t.Fatalf("SQL 文本解码错误：%+v", rows)
			}
			expectPass(t, assertSqlGrantsWithinDatabase("appdb", sqlGrantRows{UserPrivileges: rows}), "解码后的 USAGE")
		})
	}
}
