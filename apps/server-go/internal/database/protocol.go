package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"

	"elysian/server/internal/shared"
)

// MySQL/MariaDB（go-sql-driver）与 Redis（go-redis，强制 RESP2）协议层；
// SQL 终端黑名单（带字符串态的注释归一）、Redis 终端黑名单与接管授权核验。

var sqlNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// sqlCharsets 建库字符集白名单。
var sqlCharsets = map[string]bool{"utf8mb4": true, "utf8": true, "latin1": true}

// sqlName 标识符白名单校验，返回反引号包裹形态。
func sqlName(name string) (string, error) {
	if !sqlNamePattern.MatchString(name) {
		return "", shared.InvalidRequest("数据库名或用户名只能使用英文字母、数字和下划线，并须以字母开头")
	}
	return "`" + name + "`", nil
}

// mysqlConnect 建立一次性 MySQL 连接（拨号超时 5s；连接随用随关）。
func mysqlConnect(addr databaseAddress, credential databaseSecret, database string) (*sql.DB, error) {
	return sql.Open("mysql", mysqlDSN(credential, addr, database))
}

// mysqlDSN 按用户名/密码/地址拼装 DSN，特殊字符按驱动规则转义。
func mysqlDSN(credential databaseSecret, addr databaseAddress, database string) string {
	replacer := strings.NewReplacer("'", "\\'", "\"", "\\\"", "\\", "\\\\", "\n", "\\n", "\r", "\\r")
	return fmt.Sprintf("%s:%s@tcp(%s)/%s?timeout=5s",
		replacer.Replace(credential.Username), replacer.Replace(credential.Password),
		net.JoinHostPort(addr.Host, strconv.Itoa(addr.Port)), database)
}

// redisConnect 建立一次性 Redis 连接（RESP2、禁自动重连、拨号超时 5s）。
// username 为 default 时不送用户名（对齐 node-redis 的 undefined 形态）。
func redisConnect(addr databaseAddress, credential databaseSecret) *redis.Client {
	options := &redis.Options{
		Addr:        net.JoinHostPort(addr.Host, strconv.Itoa(addr.Port)),
		Password:    credential.Password,
		DB:          0,
		Protocol:    2,
		DialTimeout: 5 * time.Second,
		ReadTimeout: time.Minute,
		MaxRetries:  0,
	}
	if credential.Username != "default" {
		options.Username = credential.Username
	}
	return redis.NewClient(options)
}

// ---------- Redis 终端命令黑名单（databaseProtocol.ts:60-84） ----------

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\v' || b == '\f' || b == '\r'
}

// parseRedisWords 分词：识别双/单引号串（去引号并反转义 \"'\\）与非空白词；
// 未闭合引号串按 TS 正则落不到引号分支，整个词按 \S+ 取得后再剥首尾字符。
func parseRedisWords(input string) []string {
	var words []string
	i, n := 0, len(input)
	for i < n {
		if isSpaceByte(input[i]) {
			i++
			continue
		}
		if input[i] == '"' || input[i] == '\'' {
			quote := input[i]
			j := i + 1
			for j < n {
				if input[j] == '\\' && j+1 < n && (input[j+1] == '"' || input[j+1] == '\'' || input[j+1] == '\\') {
					j += 2
					continue
				}
				if input[j] == quote {
					break
				}
				j++
			}
			if j < n {
				words = append(words, unescapeRedisWord(input[i+1:j]))
				i = j + 1
				continue
			}
			k := i
			for k < n && !isSpaceByte(input[k]) {
				k++
			}
			token := input[i:k]
			words = append(words, unescapeRedisWord(token[1:len(token)-1]))
			i = k
			continue
		}
		k := i
		for k < n && !isSpaceByte(input[k]) {
			k++
		}
		words = append(words, input[i:k])
		i = k
	}
	return words
}

// unescapeRedisWord 把 \x（x ∈ \"'\\）反转义为 x。
func unescapeRedisWord(value string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' && i+1 < len(value) && (value[i+1] == '"' || value[i+1] == '\'' || value[i+1] == '\\') {
			b.WriteByte(value[i+1])
			i++
			continue
		}
		b.WriteByte(value[i])
	}
	return b.String()
}

// redisForbidden 管理与危险命令集合。
var redisForbidden = map[string]bool{
	"ACL": true, "CONFIG": true, "MODULE": true, "EVAL": true, "EVALSHA": true, "FCALL": true,
	"FUNCTION": true, "SCRIPT": true, "DEBUG": true, "SHUTDOWN": true, "SAVE": true, "BGSAVE": true,
	"BGREWRITEAOF": true, "FLUSHALL": true, "FLUSHDB": true, "SELECT": true, "MIGRATE": true,
	"RESTORE": true, "MOVE": true, "COPY": true, "SWAPDB": true, "REPLICAOF": true, "SLAVEOF": true,
	"CLUSTER": true, "CLIENT": true, "MONITOR": true, "SYNC": true, "PSYNC": true, "COMMAND": true,
	"HELLO": true, "AUTH": true, "QUIT": true, "LATENCY": true, "SLOWLOG": true, "MEMORY": true,
	"EVAL_RO": true, "EVALSHA_RO": true, "FCALL_RO": true, "PUBSUB": true, "SUBSCRIBE": true,
	"PSUBSCRIBE": true, "SSUBSCRIBE": true,
}

// validateRedisTerminalCommand 校验并分词 Redis 终端命令。
func validateRedisTerminalCommand(input string) ([]string, error) {
	args := parseRedisWords(input)
	if len(args) == 0 {
		return nil, shared.InvalidRequest("请输入 Redis 命令")
	}
	if len(strings.Join(args, " ")) > 64*1024 {
		return nil, shared.InvalidRequest("命令超过 64 KiB")
	}
	if redisForbidden[strings.ToUpper(args[0])] {
		return nil, &shared.InvalidRequestError{Status: 403, Message: "该 Redis 管理命令不可在数据库终端执行"}
	}
	return args, nil
}

// ---------- MySQL 授权白名单核验（INFORMATION_SCHEMA 视图） ----------

// sqlGrantRow 一张授权视图的行（字段宽松取用）。
type sqlGrantRow struct {
	PrivilegeType string
	IsGrantable   string
	TableSchema   string
}

// sqlGrantRows 六视图行集。
type sqlGrantRows struct {
	UserPrivileges    []sqlGrantRow
	SchemaPrivileges  []sqlGrantRow
	TablePrivileges   []sqlGrantRow
	ColumnPrivileges  []sqlGrantRow
	RoutinePrivileges []sqlGrantRow
	ApplicableRoles   []sqlGrantRow
}

// assertSqlGrantsWithinDatabase 接管核验：普通账号授权必须完全落在目标库内。
func assertSqlGrantsWithinDatabase(name string, rows sqlGrantRows) error {
	if len(rows.ApplicableRoles) > 0 {
		return &shared.InvalidRequestError{Status: 403, Message: "普通账号存在可适用角色，权限可能越出目标库"}
	}
	for _, row := range rows.UserPrivileges {
		if strings.ToUpper(row.PrivilegeType) != "USAGE" {
			return &shared.InvalidRequestError{Status: 403, Message: "普通账号拥有全局权限"}
		}
	}
	grantable := append(append(append(append([]sqlGrantRow{}, rows.UserPrivileges...),
		rows.SchemaPrivileges...), rows.TablePrivileges...), rows.ColumnPrivileges...)
	grantable = append(grantable, rows.RoutinePrivileges...)
	for _, row := range grantable {
		if strings.ToUpper(row.IsGrantable) == "YES" {
			return &shared.InvalidRequestError{Status: 403, Message: "普通账号拥有超出目标数据库的权限"}
		}
	}
	scoped := append(append(append([]sqlGrantRow{}, rows.SchemaPrivileges...),
		rows.TablePrivileges...), rows.ColumnPrivileges...)
	scoped = append(scoped, rows.RoutinePrivileges...)
	for _, row := range scoped {
		if row.TableSchema != name {
			return &shared.InvalidRequestError{Status: 403, Message: "普通账号拥有其他数据库权限"}
		}
	}
	return nil
}

// ---------- SQL 终端黑名单（带字符串态的注释归一） ----------

// normalizeSqlComments 注释归一：单/双/反引号区间原样保留，区间外把 -- 行注释、
// # 行注释、闭合块注释各替换为一个空格；/*! 版本执行注释原文保留供黑名单匹配；
// 未闭合块注释 400；未闭合引号保留原文。
func normalizeSqlComments(input string) (string, error) {
	findQuoteEnd := func(start int, quote byte) int {
		i := start + 1
		for i < len(input) {
			ch := input[i]
			if (quote == '\'' || quote == '"') && ch == '\\' {
				i += 2
				continue
			}
			if ch == quote {
				if i+1 < len(input) && input[i+1] == quote {
					i += 2
					continue
				}
				return i + 1
			}
			i++
		}
		return -1
	}
	var out strings.Builder
	i, n := 0, len(input)
	for i < n {
		ch := input[i]
		if ch == '\'' || ch == '"' || ch == '`' {
			end := findQuoteEnd(i, ch)
			if end < 0 {
				out.WriteString(input[i:])
				break
			}
			out.WriteString(input[i:end])
			i = end
			continue
		}
		// 行尾裸 `--`（第二减号后无字符）不是注释：保留原文。
		if ch == '-' && i+1 < n && input[i+1] == '-' && i+2 < n && input[i+2] <= 0x20 {
			newline := strings.IndexByte(input[i+2:], '\n')
			if newline < 0 {
				i = n
			} else {
				i = i + 2 + newline
			}
			out.WriteByte(' ')
			continue
		}
		if ch == '#' {
			newline := strings.IndexByte(input[i+1:], '\n')
			if newline < 0 {
				i = n
			} else {
				i = i + 1 + newline
			}
			out.WriteByte(' ')
			continue
		}
		if ch == '/' && i+1 < n && input[i+1] == '*' {
			end := strings.Index(input[i+2:], "*/")
			if end < 0 {
				return "", shared.InvalidRequest("SQL 注释未闭合")
			}
			if input[i+2] == '!' {
				out.WriteString(input[i : i+2+end+2])
			} else {
				out.WriteByte(' ')
			}
			i = i + 2 + end + 2
			continue
		}
		out.WriteByte(ch)
		i++
	}
	return out.String(), nil
}

// sqlTerminalForbidden 禁词正则（USE 的前向断言由 useSwitchesDatabase 担纲）。
var sqlTerminalForbidden = regexp.MustCompile("(?i)\\b(?:LOAD\\s+DATA|INTO\\s+(?:OUTFILE|DUMPFILE)|LOAD_FILE\\s*\\(|INSTALL\\s+PLUGIN|CREATE\\s+FUNCTION|SET\\s+(?:@@)?(?:GLOBAL|SESSION|LOCAL)\\b|SET\\s+(?:DEFAULT\\s+)?ROLE\\b|CALL\\s+`?\\w+`?\\s*\\.)")

// useTerminalPattern USE 禁词的字面匹配。
var useTerminalPattern = regexp.MustCompile(`(?i)\bUSE\b`)

// useSwitchesDatabase 判定归一后的文本里出现 USE 且后随空白或反引号。
func useSwitchesDatabase(normalized string) bool {
	for _, match := range useTerminalPattern.FindAllStringIndex(normalized, -1) {
		end := match[1]
		if end < len(normalized) && (isSpaceByte(normalized[end]) || normalized[end] == '`') {
			return true
		}
	}
	return false
}

// validateSqlTerminalStatement 会话黑名单判定：先注释归一再匹配禁词；执行仍送原文。
func validateSqlTerminalStatement(input string) error {
	if len(input) > 64*1024 {
		return shared.InvalidRequest("SQL 超过 64 KiB")
	}
	normalized, err := normalizeSqlComments(input)
	if err != nil {
		return err
	}
	if sqlTerminalForbidden.MatchString(normalized) || useSwitchesDatabase(normalized) {
		return &shared.InvalidRequestError{Status: 403, Message: "数据库终端禁止文件、系统管理和跨库操作"}
	}
	return nil
}

// ---------- 协议层本体 ----------

var redisVersionPattern = regexp.MustCompile(`(?m)^redis_version:(.+)$`)

// protocolAPI MySQL/Redis 协议操作集。
type protocolAPI struct{}

func newProtocolAPI() *protocolAPI { return &protocolAPI{} }

// version 读取服务端实际版本。
func (p *protocolAPI) version(ctx context.Context, engine string, addr databaseAddress, credential databaseSecret) (string, error) {
	if engine == engineRedis {
		client := redisConnect(addr, credential)
		defer client.Close()
		info, err := client.Do(ctx, "INFO", "server").Text()
		if err != nil {
			return "", err
		}
		if m := redisVersionPattern.FindStringSubmatch(info); m != nil {
			return strings.TrimSpace(m[1]), nil
		}
		return "", nil
	}
	db, err := mysqlConnect(addr, credential, "")
	if err != nil {
		return "", err
	}
	defer db.Close()
	var version sql.NullString
	if err := db.QueryRowContext(ctx, "SELECT VERSION() AS version").Scan(&version); err != nil {
		return "", err
	}
	if !version.Valid {
		return "", nil
	}
	return version.String, nil
}

// create 建库建账号并授权（Redis 为 no-op：ACL 随容器启动写入）。
func (p *protocolAPI) create(ctx context.Context, record databaseRecord, addr databaseAddress, charset string) error {
	if record.Engine == engineRedis {
		return nil
	}
	if !sqlCharsets[charset] {
		return shared.InvalidRequest("字符集不受支持")
	}
	escaped, err := sqlName(record.Name)
	if err != nil {
		return err
	}
	db, err := mysqlConnect(addr, record.Admin, "")
	if err != nil {
		return err
	}
	defer db.Close()
	statements := []struct {
		query string
		args  []any
	}{
		{fmt.Sprintf("CREATE DATABASE %s CHARACTER SET %s", escaped, charset), nil},
		{"CREATE USER ?@'%' IDENTIFIED BY ?", []any{record.User.Username, record.User.Password}},
		{fmt.Sprintf("GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER ON %s.* TO ?@'%%'", escaped), []any{record.User.Username}},
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	return nil
}

// parseAclGetUserReply 把 ACL GETUSER 的扁平键值数组转为 map。
func parseAclGetUserReply(reply any) map[string]any {
	parsed := map[string]any{}
	if items, ok := reply.([]any); ok {
		for i := 0; i+1 < len(items); i += 2 {
			key, _ := items[i].(string)
			parsed[key] = items[i+1]
		}
		return parsed
	}
	if m, ok := reply.(map[string]any); ok {
		return m
	}
	return parsed
}

var redisAclOverprivileged = regexp.MustCompile(`(?i)\+@(?:admin|dangerous|scripting)\b|\+(?:acl|config|module|eval|evalsha|eval_ro|evalsha_ro|fcall|fcall_ro|function|script|debug|shutdown|flushall|flushdb|select|migrate|restore|move|copy|swapdb|replicaof|slaveof|cluster|monitor|sync|psync)\b`)

// verify 接管核验：Redis 核对 ACL 形态并用 DRYRUN 复核；SQL 用管理员确认库存在、
// 普通账号自查六视图，任何查询异常即失败（fail-closed）。
func (p *protocolAPI) verify(ctx context.Context, record databaseRecord, addr databaseAddress) error {
	if record.Engine == engineRedis {
		admin := redisConnect(addr, record.Admin)
		defer admin.Close()
		aclReply, err := admin.Do(ctx, "ACL", "GETUSER", record.User.Username).Result()
		if err != nil {
			return err
		}
		parsed := parseAclGetUserReply(aclReply)
		commands, _ := parsed["commands"].(string)
		allPosition := strings.LastIndex(commands, "+@all")
		var flags []string
		if raw, ok := parsed["flags"].([]any); ok {
			for _, item := range raw {
				flags = append(flags, asString(item))
			}
		}
		selectors, hasSelectors := parsed["selectors"].([]any)
		nopass := false
		for _, flag := range flags {
			if flag == "nopass" {
				nopass = true
			}
		}
		dangerousFollowUp := allPosition >= 0 && (strings.LastIndex(commands, "-@dangerous") < allPosition ||
			strings.LastIndex(commands, "-@scripting") < allPosition || strings.LastIndex(commands, "-select") < allPosition ||
			strings.LastIndex(commands, "-move") < allPosition || strings.LastIndex(commands, "-copy") < allPosition)
		if commands == "" || nopass || (hasSelectors && len(selectors) > 0) ||
			redisAclOverprivileged.MatchString(commands) || dangerousFollowUp {
			return &shared.InvalidRequestError{Status: 403, Message: "普通 Redis 账号权限过大或不存在"}
		}
		forbidden := [][]string{
			{"SELECT", "1"}, {"MOVE", "elysian_acl_probe", "1"},
			{"COPY", "elysian_acl_probe", "elysian_acl_probe_copy", "DB", "1"},
			{"FLUSHDB"}, {"CONFIG", "GET", "dir"}, {"ACL", "LIST"},
			{"EVAL", "return 1", "0"}, {"EVAL_RO", "return 1", "0"},
		}
		for _, command := range forbidden {
			args := append([]any{"ACL", "DRYRUN", record.User.Username}, stringsToAny(command)...)
			allowed, err := admin.Do(ctx, args...).Text()
			if err != nil {
				return err
			}
			if allowed == "OK" {
				return &shared.InvalidRequestError{Status: 403, Message: "普通 Redis 账号拥有跨库、管理或脚本权限"}
			}
		}
		user := redisConnect(addr, record.User)
		defer user.Close()
		if err := user.Ping(ctx).Err(); err != nil {
			return err
		}
		return nil
	}
	admin, err := mysqlConnect(addr, record.Admin, "")
	if err != nil {
		return err
	}
	defer admin.Close()
	var schemaName string
	err = admin.QueryRowContext(ctx, "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?", record.Name).Scan(&schemaName)
	if errors.Is(err, sql.ErrNoRows) {
		return &shared.InvalidRequestError{Status: 404, Message: "目标逻辑库已不存在"}
	}
	if err != nil {
		return err
	}
	user, err := mysqlConnect(addr, record.User, record.Name)
	if err != nil {
		return err
	}
	defer user.Close()
	rows := sqlGrantRows{}
	if rows.UserPrivileges, err = queryGrantRows(ctx, user, "SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM INFORMATION_SCHEMA.USER_PRIVILEGES"); err != nil {
		return err
	}
	if rows.SchemaPrivileges, err = queryGrantRows(ctx, user, "SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.SCHEMA_PRIVILEGES"); err != nil {
		return err
	}
	if rows.TablePrivileges, err = queryGrantRows(ctx, user, "SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.TABLE_PRIVILEGES"); err != nil {
		return err
	}
	if rows.ColumnPrivileges, err = queryGrantRows(ctx, user, "SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES"); err != nil {
		return err
	}
	if rows.RoutinePrivileges, err = queryGrantRows(ctx, user, "SELECT TABLE_SCHEMA, IS_GRANTABLE FROM INFORMATION_SCHEMA.ROUTINE_PRIVILEGES"); err != nil {
		return err
	}
	if rows.ApplicableRoles, err = queryGrantRows(ctx, user, "SELECT * FROM INFORMATION_SCHEMA.APPLICABLE_ROLES"); err != nil {
		return err
	}
	return assertSqlGrantsWithinDatabase(record.Name, rows)
}

// stringsToAny 把 []string 展开为 []any（go-redis Do 的变参形态）。
func stringsToAny(values []string) []any {
	out := make([]any, len(values))
	for i, value := range values {
		out[i] = value
	}
	return out
}

// queryGrantRows 执行授权视图查询并归一为宽松行（SELECT * 的 APPLICABLE_ROLES
// 只关心行数）。
func queryGrantRows(ctx context.Context, db *sql.DB, query string) ([]sqlGrantRow, error) {
	result, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer result.Close()
	var rows []sqlGrantRow
	for result.Next() {
		columns, err := result.Columns()
		if err != nil {
			return nil, err
		}
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := result.Scan(pointers...); err != nil {
			return nil, err
		}
		row := sqlGrantRow{}
		for i, column := range columns {
			switch strings.ToUpper(column) {
			case "PRIVILEGE_TYPE":
				row.PrivilegeType = asString(values[i])
			case "IS_GRANTABLE":
				row.IsGrantable = asString(values[i])
			case "TABLE_SCHEMA":
				row.TableSchema = asString(values[i])
			}
		}
		rows = append(rows, row)
	}
	return rows, result.Err()
}

// drop 删除逻辑库（SQL 顺带删受管账号；Redis 清空 DB 0）。
func (p *protocolAPI) drop(ctx context.Context, record databaseRecord, addr databaseAddress) error {
	if record.Engine == engineRedis {
		client := redisConnect(addr, record.Admin)
		defer client.Close()
		return client.Do(ctx, "FLUSHDB", "ASYNC").Err()
	}
	escaped, err := sqlName(record.Name)
	if err != nil {
		return err
	}
	db, err := mysqlConnect(addr, record.Admin, "")
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s", escaped)); err != nil {
		return err
	}
	if record.Source == sourceManaged {
		if _, err := db.ExecContext(ctx, "DROP USER IF EXISTS ?@'%'", record.User.Username); err != nil {
			return err
		}
	}
	return nil
}

var redisKeyspaceOtherDB = regexp.MustCompile(`(?m)^db[1-9][0-9]*:`)

// hasOtherDatabases 容器里是否还有未登记的其他逻辑库。
func (p *protocolAPI) hasOtherDatabases(ctx context.Context, record databaseRecord, addr databaseAddress) (bool, error) {
	if record.Engine == engineRedis {
		client := redisConnect(addr, record.Admin)
		defer client.Close()
		keyspace, err := client.Do(ctx, "INFO", "keyspace").Text()
		if err != nil {
			return false, err
		}
		return redisKeyspaceOtherDB.MatchString(keyspace), nil
	}
	db, err := mysqlConnect(addr, record.Admin, "")
	if err != nil {
		return false, err
	}
	defer db.Close()
	var schema string
	err = db.QueryRowContext(ctx,
		"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') AND SCHEMA_NAME <> ? LIMIT 1",
		record.Name).Scan(&schema)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

var (
	redisUsedMemoryPattern     = regexp.MustCompile(`(?m)^used_memory:(\d+)`)
	redisConnectedClientsRegex = regexp.MustCompile(`(?m)^connected_clients:(\d+)`)
)

// metrics 采样容量与连接指标。
func (p *protocolAPI) metrics(ctx context.Context, record databaseRecord, addr databaseAddress) (databaseMetrics, error) {
	if record.Engine == engineRedis {
		client := redisConnect(addr, record.Admin)
		defer client.Close()
		memory, err := client.Do(ctx, "INFO", "memory").Text()
		if err != nil {
			return databaseMetrics{}, err
		}
		clients, err := client.Do(ctx, "INFO", "clients").Text()
		if err != nil {
			return databaseMetrics{}, err
		}
		used, _ := strconv.ParseFloat(regexGroup(redisUsedMemoryPattern, memory, "0"), 64)
		active, _ := strconv.ParseFloat(regexGroup(redisConnectedClientsRegex, clients, "0"), 64)
		sizeGb := used / (1024 * 1024 * 1024)
		return databaseMetrics{SizeGb: &sizeGb, Connections: &connectionsView{Active: int(active), Max: 0}}, nil
	}
	db, err := mysqlConnect(addr, record.Admin, "")
	if err != nil {
		return databaseMetrics{}, err
	}
	defer db.Close()
	var sizeBytes float64
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(SUM(data_length + index_length),0) AS bytes FROM information_schema.tables WHERE table_schema = ?", record.Name).Scan(&sizeBytes); err != nil {
		return databaseMetrics{}, err
	}
	var threadsName, threadsValue string
	if err := db.QueryRowContext(ctx, "SHOW GLOBAL STATUS LIKE 'Threads_connected'").Scan(&threadsName, &threadsValue); err != nil {
		return databaseMetrics{}, err
	}
	var maxName, maxValue string
	if err := db.QueryRowContext(ctx, "SHOW GLOBAL VARIABLES LIKE 'max_connections'").Scan(&maxName, &maxValue); err != nil {
		return databaseMetrics{}, err
	}
	sizeGb := sizeBytes / (1024 * 1024 * 1024)
	active, _ := strconv.ParseFloat(strings.TrimSpace(threadsValue), 64)
	maximum, _ := strconv.ParseFloat(strings.TrimSpace(maxValue), 64)
	return databaseMetrics{SizeGb: &sizeGb, Connections: &connectionsView{Active: int(active), Max: int(maximum)}}, nil
}

// regexGroup 取正则首个匹配的捕获组；未命中回缺省值。
func regexGroup(pattern *regexp.Regexp, text, fallback string) string {
	if m := pattern.FindStringSubmatch(text); m != nil {
		return m[1]
	}
	return fallback
}

// session 打开数据库协议终端会话。
func (p *protocolAPI) session(record databaseRecord, addr databaseAddress) (Session, error) {
	if record.Engine == engineRedis {
		return openBoundedRedisTerminal(addr, record.User, validateRedisTerminalCommand)
	}
	return newMysqlTerminalSession(record, addr)
}

// mysqlOkLine MySQL 终端 OK 包回显行（键序对齐 mysql2 ResultSetHeader 的序列化形态；
// serverStatus/warningStatus 等驱动内部字段以 0 呈现，见盘点迁移风险）。
type mysqlOkLine struct {
	FieldCount    int    `json:"fieldCount"`
	AffectedRows  int64  `json:"affectedRows"`
	InsertID      int64  `json:"insertId"`
	Info          string `json:"info"`
	ServerStatus  int    `json:"serverStatus"`
	WarningStatus int    `json:"warningStatus"`
	ChangedRows   int    `json:"changedRows"`
}

const (
	mysqlMaxOutput    = 1024 * 1024
	mysqlMaxRows      = 500
	mysqlQueryTimeout = 15 * time.Second
)

// mysqlTerminalSession MySQL 终端会话：单连接、15s 查询超时、500 行 / 1 MiB 输出上限。
type mysqlTerminalSession struct {
	db     *sql.DB
	broken bool
}

func newMysqlTerminalSession(record databaseRecord, addr databaseAddress) (*mysqlTerminalSession, error) {
	db, err := mysqlConnect(addr, record.User, record.Name)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return &mysqlTerminalSession{db: db}, nil
}

// destroy 中断底层连接（超限与错误路径共用）。
func (s *mysqlTerminalSession) destroy() {
	if !s.broken {
		s.broken = true
		_ = s.db.Close()
	}
}

// Execute 校验并执行一条 SQL，输出列名行 + 数据行（或 OK 包回显行）。
// 统一走 QueryContext（COM_QUERY 文本协议，对齐 mysql2 的 query）：
// 有结果集流式输出；无结果集（0 列）输出 OK 包回显行——受 database/sql 抽象
// 限制，驱动 result 的 affectedRows 不可得，恒 0（登记 gaps，行为差异点）。
func (s *mysqlTerminalSession) Execute(ctx context.Context, input string) ([]string, error) {
	if err := validateSqlTerminalStatement(input); err != nil {
		return nil, err
	}
	if s.broken {
		return nil, errors.New("数据库终端连接已中断")
	}
	queryCtx, cancel := context.WithTimeout(ctx, mysqlQueryTimeout)
	defer cancel()
	rows, err := s.db.QueryContext(queryCtx, input)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		line, err := shared.MarshalJSON(mysqlOkLine{})
		if err != nil {
			return nil, err
		}
		return []string{string(line)}, nil
	}
	names := make([]string, len(columns))
	copy(names, columns)
	output := []string{strings.Join(names, "\t")}
	byteCount := len(output[0])
	count := 0
	values := make([]any, len(names))
	pointers := make([]any, len(names))
	for i := range values {
		pointers[i] = &values[i]
	}
	fail := func(message string) ([]string, error) {
		s.destroy()
		return nil, errors.New(message)
	}
	for rows.Next() {
		count++
		if count > mysqlMaxRows {
			return fail("结果超过 500 行，已中断")
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		cells := make([]string, len(values))
		for i, value := range values {
			cells[i] = mysqlCellString(value)
		}
		line := strings.Join(cells, "\t")
		byteCount += len(line)
		if byteCount > mysqlMaxOutput {
			return fail("结果超过 1 MiB，已中断")
		}
		output = append(output, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return output, nil
}

// Close 关闭会话连接。
func (s *mysqlTerminalSession) Close() error {
	s.broken = true
	return s.db.Close()
}

// mysqlCellString 行值字符串化（对齐 TS String(value)：null → "null"）。
func mysqlCellString(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case []byte:
		return string(v)
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}
