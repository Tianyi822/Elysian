package database

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"elysian/server/internal/shared"
)

// MySQL/MariaDB 实例内的管理操作：就绪等待与「建库 + 专属用户 + 授权」。官方镜像初始化时
// 会先起一个只监听 socket 的临时实例，所以一律经容器内回环 TCP 连接：初始化完成前连接
// 被拒绝，不会把建库写到临时实例上。

const (
	// mysqlReadyTimeout 是等待实例可登录的上限；mysqlReadyPause 是两次探测的间隔。
	mysqlReadyTimeout = 120 * time.Second
	mysqlReadyPause   = 2 * time.Second
	// mysqlCommandTimeout 是单条管理命令的执行上限。
	mysqlCommandTimeout = 30 * time.Second
	// mysqlAdminShell 只含变量引用：管理员密码与 SQL 都经环境变量进入容器，再由内建 printf 把 SQL
	// 送进 mysql 的标准输入。不能用 -e "$变量"：展开后的 SQL（含新用户密码）会成为容器内
	// mysql 进程的参数，宿主机上经 /proc 可读；内建 printf 不产生带参数的进程。
	mysqlAdminShell = `printf '%s' "$MYSQL_SCRIPT" | mysql --protocol=TCP -h127.0.0.1 -P3306 -u"$MYSQL_ADMIN_USER" --batch --raw --skip-column-names`
)

var (
	logicalDatabasePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	logicalUserPattern     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,31}$`)
	mysqlNativeGrantHash   = regexp.MustCompile(`^'\*[a-fA-F0-9]{40}'$`)
)

// logicalPlan 是一次逻辑库创建的完整意图：标识符已校验，密码由调用方生成。
type logicalPlan struct {
	database string
	username string
	password string
}

// validateLogicalDatabase 校验逻辑库名：只能使用字母、数字和下划线，以字母开头，不超过 64 字符。
func validateLogicalDatabase(name string) error {
	if !logicalDatabasePattern.MatchString(name) {
		return shared.InvalidRequest("数据库名只能使用英文字母、数字和下划线，须以字母开头且不超过 64 个字符")
	}
	return nil
}

// validateSchemaDatabase 在格式校验之外拒绝系统库名：用它建库并授权，等于把授权表交给新用户。
// 只适用于 MySQL／MariaDB 的库；Redis 的 key 前缀不受此限。
func validateSchemaDatabase(name string) error {
	if err := validateLogicalDatabase(name); err != nil {
		return err
	}
	switch strings.ToLower(name) {
	case "mysql", "sys", "information_schema", "performance_schema":
		return shared.InvalidRequest("数据库名不能使用系统保留库（mysql、sys、information_schema、performance_schema）")
	}
	return nil
}

// validateLogicalUser 校验专属用户名，并拒绝管理员账号与系统保留账号。
func validateLogicalUser(name, adminUsername string) error {
	if !logicalUserPattern.MatchString(name) {
		return shared.InvalidRequest("数据库用户名只能使用英文字母、数字和下划线，须以字母开头且不超过 32 个字符")
	}
	lower := strings.ToLower(name)
	if lower == "root" || name == adminUsername || strings.HasPrefix(lower, "mysql.") || strings.HasPrefix(lower, "mariadb.") {
		return shared.InvalidRequest("数据库用户名不能是管理员或系统保留账号")
	}
	return nil
}

// defaultLogicalUsername 由库名推导缺省的专属用户名，保持在 MySQL 的 32 字符上限内。
func defaultLogicalUsername(database string) string {
	if name := database + "_user"; len(name) <= 32 {
		return name
	}
	return "u_" + database[:30]
}

func mysqlAdminEnv(admin databaseSecret) []string { return []string{"MYSQL_PWD=" + admin.Password} }

// waitMySQLReady 等到管理端口可登录；超过限定时间仍未就绪时报错。
func (d *dockerAPI) waitMySQLReady(ctx context.Context, containerID string, admin databaseSecret) error {
	deadline := d.now().Add(mysqlReadyTimeout)
	for {
		ready, err := d.mysqlReady(ctx, containerID, admin)
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		if !d.now().Before(deadline) {
			return errors.New("数据库实例在限定时间内未就绪")
		}
		if err := d.sleep(ctx, mysqlReadyPause); err != nil {
			return err
		}
	}
}

// mysqlReady 用容器内回环 TCP 做一次管理登录探测。
func (d *dockerAPI) mysqlReady(ctx context.Context, containerID string, admin databaseSecret) (bool, error) {
	result, err := d.exec(ctx, adminExec{
		containerID: containerID,
		argv:        []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-P3306", "-u" + admin.Username, "--connect-timeout=5", "--batch", "--skip-column-names", "-e", "SELECT 1"},
		env:         mysqlAdminEnv(admin),
		timeout:     mysqlCommandTimeout,
	})
	if err != nil {
		return false, err
	}
	return result.exitCode == 0, nil
}

// createMySQLLogical 幂等地建库、建专属用户并授权，再回读库、用户与授权确认。登记先于
// 执行，所以重试会落到同名对象上：库保持不动，用户密码被对齐到登记值。
func (d *dockerAPI) createMySQLLogical(ctx context.Context, target adminTarget, plan logicalPlan) error {
	admin := target.admin
	if err := validateSchemaDatabase(plan.database); err != nil {
		return err
	}
	if err := validateLogicalUser(plan.username, admin.Username); err != nil {
		return err
	}
	grantDatabase, err := d.mysqlGrantDatabase(ctx, target, plan.database)
	if err != nil {
		return &logicalPreflightError{err}
	}
	script := fmt.Sprintf(
		"CREATE DATABASE IF NOT EXISTS `%s`; CREATE USER IF NOT EXISTS '%s'@'%%' IDENTIFIED BY '%s'; ALTER USER '%s'@'%%' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%'; "+
			"SELECT CONCAT((SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME='%s'), ':', (SELECT COUNT(*) FROM mysql.user WHERE BINARY User='%s' AND Host='%%')); SHOW GRANTS FOR '%s'@'%%';",
		plan.database, plan.username, plan.password, plan.username, plan.password, grantDatabase, plan.username,
		plan.database, plan.username, plan.username)
	result, err := d.exec(ctx, adminExec{
		containerID: target.containerID,
		argv:        []string{"sh", "-c", mysqlAdminShell},
		env:         append(mysqlAdminEnv(admin), "MYSQL_ADMIN_USER="+admin.Username, "MYSQL_SCRIPT="+script),
		timeout:     mysqlCommandTimeout, writeStep: "mysql-logical", firstWrite: true,
	})
	if err != nil {
		return err
	}
	confirmed := result.exitCode == 0 && hasLine(result.stdout, "1:1") && exactMySQLGrants(result.stdout, grantDatabase, plan.username)
	if !confirmed {
		return &logicalWriteEndedError{errors.New("数据库或专属用户未得到创建确认")}
	}
	return nil
}

// mysqlGrantDatabase separates a schema identifier from a database-level grant pattern.
func (d *dockerAPI) mysqlGrantDatabase(ctx context.Context, target adminTarget, database string) (string, error) {
	if !strings.Contains(database, "_") {
		return database, nil
	}
	if target.engine == engineMySQL {
		result, err := d.exec(ctx, adminExec{containerID: target.containerID,
			argv: []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-u" + target.admin.Username, "--batch", "--skip-column-names", "-e", "SELECT @@GLOBAL.partial_revokes"},
			env:  mysqlAdminEnv(target.admin), timeout: mysqlCommandTimeout})
		if err != nil || result.exitCode != 0 {
			return "", errors.New("无法确认 MySQL 库级授权语义")
		}
		switch strings.TrimSpace(result.stdout) {
		case "1":
			return database, nil
		case "0":
		default:
			return "", errors.New("无法确认 MySQL 库级授权语义")
		}
	}
	return strings.ReplaceAll(database, "_", `\_`), nil
}

func exactMySQLGrants(output, database, username string) bool {
	found := false
	for line := range strings.SplitSeq(strings.TrimSpace(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "1:1" {
			continue
		}
		// Both clients quote account names, using different quote characters.
		matched := false
		for _, quote := range []string{"'", "`"} {
			account := quote + username + quote + "@" + quote + "%" + quote
			if line == "GRANT ALL PRIVILEGES ON `"+database+"`.* TO "+account {
				found, matched = true, true
				break
			}
			base := "GRANT USAGE ON *.* TO " + account
			hash, hasHash := strings.CutPrefix(line, base+" IDENTIFIED BY PASSWORD ")
			if line == base || hasHash && mysqlNativeGrantHash.MatchString(hash) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return found
}

// inspectMySQLLogical 只读核对目标库与用户是否已存在：一次管理员查询看存在性；用户存在时再用
// 登记密码做一次登录，判断它是不是面板先前建的。查询里的标识符来自已校验的名字。
func (d *dockerAPI) inspectMySQLLogical(ctx context.Context, target adminTarget, plan logicalPlan) (logicalExistence, error) {
	if err := validateSchemaDatabase(plan.database); err != nil {
		return logicalExistence{}, err
	}
	if err := validateLogicalUser(plan.username, target.admin.Username); err != nil {
		return logicalExistence{}, err
	}
	client := []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-P3306", "--connect-timeout=5", "--batch", "--raw", "--skip-column-names"}
	query := fmt.Sprintf("SELECT CONCAT((SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='%s'), ':', (SELECT COUNT(*) FROM mysql.user WHERE BINARY User='%s'))", plan.database, plan.username)
	result, err := d.exec(ctx, adminExec{containerID: target.containerID, argv: append(append([]string{}, client...), "-u"+target.admin.Username, "-e", query), env: mysqlAdminEnv(target.admin), timeout: mysqlCommandTimeout})
	if err != nil {
		return logicalExistence{}, err
	}
	parts := strings.Split(strings.TrimSpace(result.stdout), ":")
	if result.exitCode != 0 || len(parts) != 2 {
		return logicalExistence{}, errors.New("无法核对实例内已有的库与用户")
	}
	existence := logicalExistence{Database: parts[0] != "0", User: parts[1] != "0"}
	if existence.User && plan.password != "" {
		login, err := d.exec(ctx, adminExec{containerID: target.containerID, argv: append(append([]string{}, client...), "-u"+plan.username, "-e", "SELECT CURRENT_USER()"), env: []string{"MYSQL_PWD=" + plan.password}, timeout: mysqlCommandTimeout})
		if err != nil {
			return logicalExistence{}, err
		}
		existence.PasswordMatches = login.exitCode == 0 && strings.TrimSpace(login.stdout) == plan.username+"@%"
		if existence.PasswordMatches && existence.Database {
			database, err := d.mysqlGrantDatabase(ctx, target, plan.database)
			if err != nil {
				return logicalExistence{}, err
			}
			query := fmt.Sprintf("SHOW GRANTS FOR '%s'@'%%'", plan.username)
			grants, err := d.exec(ctx, adminExec{containerID: target.containerID, argv: append(append([]string{}, client...), "-u"+target.admin.Username, "-e", query), env: mysqlAdminEnv(target.admin), timeout: mysqlCommandTimeout})
			if err != nil {
				return logicalExistence{}, err
			}
			existence.PermissionsMatch = grants.exitCode == 0 && exactMySQLGrants(grants.stdout, database, plan.username)
		}
	}
	return existence, nil
}

func hasLine(text, want string) bool {
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimRight(line, "\r") == want {
			return true
		}
	}
	return false
}
