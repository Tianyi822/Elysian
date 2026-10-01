package database

import (
	"regexp"
	"strings"

	"elysian/server/internal/shared"
)

// SQLite 终端 SQL 词法校验（sqliteSqlPolicy.ts 等价物）：禁词 + 语句形状白名单 +
// 只读 PRAGMA 白名单。单引号字符串内容不参与判定；双引号、反引号、方括号标识符
// 区间内容参与禁词与形状判定（fail-closed，区间内翻倍引号当分隔符）。

const sqliteMaxSQLBytes = 64 * 1024

// sqliteForbiddenWords 禁词集合。
var sqliteForbiddenWords = map[string]bool{
	"ATTACH": true, "DETACH": true, "VACUUM": true, "LOAD_EXTENSION": true, "READFILE": true,
	"WRITEFILE": true, "VIRTUAL": true, "TRIGGER": true, "ANALYZE": true, "REINDEX": true,
}

// sqliteReadPragmas 只读 PRAGMA 白名单（契约 SQLITE_READ_PRAGMAS 的服务端镜像；
// 前端补全词表共用同一份契约，Go 侧上移 contract 的事宜登记 gaps）。
var sqliteReadPragmas = map[string]bool{
	"TABLE_INFO": true, "TABLE_XINFO": true, "INDEX_LIST": true, "INDEX_INFO": true,
	"INDEX_XINFO": true, "FOREIGN_KEY_LIST": true, "DATABASE_LIST": true, "USER_VERSION": true,
	"PAGE_SIZE": true, "JOURNAL_MODE": true,
}

var sqliteWordPattern = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`)

func isSQLSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\v' || b == '\f' || b == '\r'
}

// validateSqliteStatement 校验单条 SQLite 语句的边界与形状。
func validateSqliteStatement(sqlText string) error {
	if strings.TrimSpace(sqlText) == "" {
		return &shared.InvalidRequestError{Status: 400, Message: "请输入 SQL 语句"}
	}
	if len(sqlText) > sqliteMaxSQLBytes {
		return &shared.InvalidRequestError{Status: 413, Message: "SQL 超过 64 KiB"}
	}
	var words []string
	hasAssignment := false
	hasCall := false
	semicolon := false
	afterEnd := false
	i, n := 0, len(sqlText)
	for i < n {
		ch := sqlText[i]
		if isSQLSpace(ch) {
			i++
			continue
		}
		if ch == '-' && i+1 < n && sqlText[i+1] == '-' {
			i += 2
			for i < n && sqlText[i] != '\n' {
				i++
			}
			continue
		}
		if ch == '/' && i+1 < n && sqlText[i+1] == '*' {
			end := strings.Index(sqlText[i+2:], "*/")
			if end < 0 {
				return &shared.InvalidRequestError{Status: 400, Message: "SQL 注释未闭合"}
			}
			i = i + 2 + end + 2
			continue
		}
		if ch == ';' {
			if semicolon {
				return &shared.InvalidRequestError{Status: 403, Message: "一次只能执行一条 SQL"}
			}
			semicolon = true
			i++
			continue
		}
		if semicolon {
			afterEnd = true
		}
		if ch == '\'' || ch == '"' || ch == '`' || ch == '[' {
			close := byte(']')
			if ch != '[' {
				close = ch
			}
			i++
			closed := false
			start := i
			for i < n {
				if sqlText[i] == close {
					if i+1 < n && sqlText[i+1] == close {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return &shared.InvalidRequestError{Status: 400, Message: "SQL 引号未闭合"}
			}
			if ch != '\'' {
				for _, match := range sqliteWordPattern.FindAllString(sqlText[start:i-1], -1) {
					words = append(words, strings.ToUpper(match))
				}
			}
			continue
		}
		if isSQLLetter(ch) {
			start := i
			i++
			for i < n && isSQLWordByte(sqlText[i]) {
				i++
			}
			words = append(words, strings.ToUpper(sqlText[start:i]))
			continue
		}
		if ch == '=' {
			hasAssignment = true
		}
		if ch == '(' {
			hasCall = true
		}
		i++
	}
	if afterEnd || len(words) == 0 {
		return &shared.InvalidRequestError{Status: 403, Message: "一次只能执行一条 SQL"}
	}
	for _, word := range words {
		if sqliteForbiddenWords[word] {
			return &shared.InvalidRequestError{Status: 403, Message: "数据库终端禁止文件、扩展与系统操作"}
		}
	}
	first, second, third := words[0], "", ""
	if len(words) > 1 {
		second = words[1]
	}
	if len(words) > 2 {
		third = words[2]
	}
	basic := map[string]bool{"SELECT": true, "WITH": true, "INSERT": true, "UPDATE": true, "DELETE": true,
		"REPLACE": true, "BEGIN": true, "COMMIT": true, "END": true, "ROLLBACK": true, "SAVEPOINT": true, "RELEASE": true}
	if basic[first] {
		return nil
	}
	if first == "CREATE" && (second == "TABLE" || second == "INDEX" || second == "VIEW" || (second == "UNIQUE" && third == "INDEX")) {
		return nil
	}
	if first == "DROP" && (second == "TABLE" || second == "INDEX" || second == "VIEW") {
		return nil
	}
	if first == "ALTER" && second == "TABLE" {
		return nil
	}
	if first == "PRAGMA" && sqliteReadPragmas[second] && !hasAssignment && (second != "USER_VERSION" || !hasCall) {
		return nil
	}
	return &shared.InvalidRequestError{Status: 403, Message: "该 SQL 类型不允许在数据库终端执行"}
}

func isSQLLetter(b byte) bool { return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }

func isSQLWordByte(b byte) bool { return isSQLLetter(b) || (b >= '0' && b <= '9') }
