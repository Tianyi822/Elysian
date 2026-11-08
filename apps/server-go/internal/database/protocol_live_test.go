package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

// 显式启用的真实协议回归；仅在提供的测试实例中创建并清理随机前缀库和账号。
// 凭据由测试机器上的 0600 文件提供，不进入环境变量或测试输出。
func TestSQLProtocolLiveCreateVerifyRoutineGrantsAndDrop(t *testing.T) {
	credentialPath := os.Getenv("ELYSIAN_TEST_SQL_CREDENTIAL_FILE")
	if credentialPath == "" {
		t.Skip("未提供真实 SQL 测试实例")
	}
	raw, err := os.ReadFile(credentialPath)
	if err != nil {
		t.Fatal("读取测试凭据失败")
	}
	var adminSecret databaseSecret
	if err := json.Unmarshal(raw, &adminSecret); err != nil {
		t.Fatal("测试凭据格式错误")
	}
	host, port, err := net.SplitHostPort(os.Getenv("ELYSIAN_TEST_SQL_ADDRESS"))
	if err != nil {
		t.Fatal("测试地址无效")
	}
	n, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal("测试端口无效")
	}
	address := databaseAddress{Host: host, Port: n}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	admin, err := mysqlConnect(address, adminSecret, "")
	if err != nil {
		t.Fatal("创建测试管理员连接失败")
	}
	defer admin.Close()
	readyDeadline := time.Now().Add(45 * time.Second)
	for {
		if err := admin.PingContext(ctx); err == nil {
			break
		} else if time.Now().After(readyDeadline) {
			t.Fatalf("测试实例未就绪：%v", err)
		}
		time.Sleep(time.Second)
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	name := "elycheck_" + hex.EncodeToString(nonce[:])
	other := name + "_other"
	record := databaseRecord{Engine: engineMySQL, Name: name, Source: sourceManaged, Admin: adminSecret, User: databaseSecret{Username: name, Password: hex.EncodeToString(nonce[:]) + "_Test9"}}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("测试 SQL 操作失败：%v", err)
		}
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		for _, q := range []string{"DROP USER IF EXISTS '" + name + "'@'%'", "DROP DATABASE IF EXISTS `" + name + "`", "DROP DATABASE IF EXISTS `" + other + "`"} {
			if _, err := admin.ExecContext(cleanup, q); err != nil {
				t.Errorf("测试资源清理失败：%v", err)
			}
		}
	}()
	p := newProtocolAPI()
	if err := p.create(ctx, record, address, "utf8mb4"); err != nil {
		t.Fatalf("真实建库与账号创建失败：%v", err)
	}
	if err := p.verify(ctx, record, address); err != nil {
		t.Fatalf("普通单库账号必须通过完整核验：%v", err)
	}
	exec(fmt.Sprintf("CREATE PROCEDURE `%s`.`grant_probe`() SQL SECURITY INVOKER SELECT 1", name))
	exec(fmt.Sprintf("GRANT EXECUTE ON PROCEDURE `%s`.`grant_probe` TO ?@'%%'", name), name)
	if err := p.verify(ctx, record, address); err != nil {
		t.Fatalf("目标库内例程授权必须通过：%v", err)
	}
	exec("CREATE DATABASE `" + other + "`")
	exec(fmt.Sprintf("CREATE PROCEDURE `%s`.`grant_probe`() SQL SECURITY INVOKER SELECT 1", other))
	exec(fmt.Sprintf("GRANT EXECUTE ON PROCEDURE `%s`.`grant_probe` TO ?@'%%'", other), name)
	expectInvalidRequest(t, p.verify(ctx, record, address), 403, "其他数据库")
	exec(fmt.Sprintf("REVOKE EXECUTE ON PROCEDURE `%s`.`grant_probe` FROM ?@'%%'", other), name)
	exec(fmt.Sprintf("GRANT EXECUTE ON PROCEDURE `%s`.`grant_probe` TO ?@'%%' WITH GRANT OPTION", name), name)
	expectInvalidRequest(t, p.verify(ctx, record, address), 403, "超出目标数据库")
	exec(fmt.Sprintf("REVOKE GRANT OPTION ON PROCEDURE `%s`.`grant_probe` FROM ?@'%%'", name), name)
	if err := p.verify(ctx, record, address); err != nil {
		t.Fatalf("撤销转授权后应恢复通过：%v", err)
	}
	if err := p.drop(ctx, record, address); err != nil {
		t.Fatalf("真实删除库与账号失败：%v", err)
	}
	var remaining int
	if err := admin.QueryRowContext(ctx, "SELECT COUNT(*) FROM mysql.user WHERE User=?", name).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatal("删除后测试账号仍然存在或无法核验")
	}
	if err := admin.QueryRowContext(ctx, "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?", name).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatal("删除后测试库仍然存在或无法核验")
	}
}
