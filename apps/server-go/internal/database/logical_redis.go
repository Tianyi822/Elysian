package database

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Redis 实例内的管理操作：就绪探测与按 key 前缀隔离的 ACL 用户。密码只经 REDISCLI_AUTH
// 环境变量传入，argv 里只出现固定客户端、校验过的标识符与命令白名单。
// ACL 必须能落盘（aclfile 非空）才建用户：否则重启后面板登记的用户会静默消失。

const (
	redisReadyTimeout   = 60 * time.Second
	redisReadyPause     = time.Second
	redisCommandTimeout = 20 * time.Second
)

// redisClient 是只在容器内执行的固定客户端调用；密码经 REDISCLI_AUTH。
func redisClientArgs(args ...string) []string {
	return append([]string{"redis-cli", "-h", "127.0.0.1", "-p", "6379", "--no-auth-warning"}, args...)
}

// defaultAdminUsername 是各引擎官方镜像的管理员账号名。已有登记行的管理员用户名优先。
func defaultAdminUsername(engine string, admin *databaseSecret) string {
	if admin != nil && admin.Username != "" {
		return admin.Username
	}
	if engine == engineRedis {
		return "default"
	}
	return "root"
}

func (d *dockerAPI) waitRedisReady(ctx context.Context, containerID string, admin databaseSecret) error {
	deadline := d.now().Add(redisReadyTimeout)
	for {
		result, err := d.exec(ctx, adminExec{containerID: containerID, argv: redisClientArgs("PING"), env: []string{"REDISCLI_AUTH=" + admin.Password}, timeout: redisCommandTimeout})
		if err != nil {
			return err
		}
		if result.exitCode == 0 && strings.Contains(result.stdout, "PONG") {
			return nil
		}
		if !d.now().Before(deadline) {
			return errors.New("Redis 实例在限定时间内未就绪")
		}
		if err := d.sleep(ctx, redisReadyPause); err != nil {
			return err
		}
	}
}

// createRedisACLUser 按 key 前缀建 ACL 用户、落盘并回读确认。前置检查不通过时不执行任何变更。
// ACL 命令一律带 --raw：成功回执只有一行 OK，正文判定需要不带序号的输出。
func (d *dockerAPI) createRedisACLUser(ctx context.Context, containerID string, admin databaseSecret, plan logicalPlan) error {
	if err := validateLogicalDatabase(plan.database); err != nil {
		return err
	}
	if err := validateLogicalUser(plan.username, "default"); err != nil {
		return err
	}
	env := []string{"REDISCLI_AUTH=" + admin.Password}
	inspect, err := d.exec(ctx, adminExec{containerID: containerID, argv: redisClientArgs("--raw", "CONFIG", "GET", "aclfile"), env: env, timeout: redisCommandTimeout})
	if err != nil {
		return &logicalPreflightError{errors.New("无法核对 Redis ACL 文件配置")}
	}
	// 输出两行：aclfile 与它的值。ACL 不支持时是错误正文。
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(inspect.stdout, "\r", ""), "\n"), "\n")
	if inspect.exitCode != 0 || len(lines) < 2 || strings.TrimSpace(lines[0]) != "aclfile" || strings.TrimSpace(lines[1]) == "" {
		return &logicalPreflightError{errors.New("Redis 实例没有启用可落盘的 ACL 文件（aclfile），无法创建重启后仍然有效的用户")}
	}
	prefix := plan.database
	rules := append([]string{plan.username, "on", "resetkeys", "~" + prefix + ":*", "resetchannels", "&" + prefix + ":*", "clearselectors"}, redisTenantCommands...)
	if result, err := d.exec(ctx, adminExec{containerID: containerID, argv: append(redisClientArgs("--raw"), append([]string{"ACL", "SETUSER"}, rules...)...), env: env, timeout: redisCommandTimeout, writeStep: "redis-acl-rules", firstWrite: true}); err != nil || !redisRepliedOK(result) {
		if err != nil {
			return err
		}
		return &logicalWriteEndedError{errors.New("Redis ACL 用户创建被拒绝")}
	}
	// 密码单独设置并经标准输入交给 redis-cli（printf 是内建命令，命令正文不进任何进程的参数）；
	// 先 resetpass 再写入：重复执行 >同一密码 会被 Redis 以「密码已存在」拒绝，重试必须幂等。
	passwordEnv := append(append([]string{}, env...), "ACL_USER="+plan.username, "ACL_PASSWORD="+plan.password)
	if result, err := d.exec(ctx, adminExec{containerID: containerID,
		argv: []string{"sh", "-c", "printf 'ACL SETUSER %s resetpass >%s\\n' \"$ACL_USER\" \"$ACL_PASSWORD\" | " + strings.Join(redisClientArgs("--raw"), " ")}, env: passwordEnv, timeout: redisCommandTimeout, writeStep: "redis-acl-password"}); err != nil || !redisRepliedOK(result) {
		if err != nil {
			return err
		}
		return &logicalWriteEndedError{errors.New("Redis ACL 用户密码设置被拒绝")}
	}
	if result, err := d.exec(ctx, adminExec{containerID: containerID, argv: redisClientArgs("--raw", "ACL", "SAVE"), env: env, timeout: redisCommandTimeout, writeStep: "redis-acl-save"}); err != nil || !redisRepliedOK(result) {
		if err != nil {
			return err
		}
		return &logicalWriteEndedError{errors.New("Redis ACL 用户落盘失败")}
	}
	if err := recordProvisionWrite(ctx, provisionWrite{Stage: "redis-acl-persisted", Finished: true}); err != nil {
		return err
	}
	readback, err := d.inspectRedisLogical(ctx, adminTarget{containerID: containerID, admin: admin}, plan)
	if err != nil {
		return err
	}
	if !readback.PermissionsMatch {
		return &logicalWriteEndedError{errors.New("Redis ACL 用户未得到创建确认")}
	}
	return nil
}

// The additional exclusions cover commands that reveal information about the
// whole keyspace or enumerate channels beyond the tenant's channel pattern.
var redisTenantCommands = []string{
	"-@all", "+@read", "+@write", "+@transaction", "+@pubsub",
	"+hello", "+ping", "+auth", "+select", "+quit", "+reset", "+echo",
	"+client|setname", "+client|setinfo", "+client|getname", "+client|id",
	"-@dangerous", "-@scripting", "-randomkey", "-scan", "-dbsize",
	"-pubsub|channels", "-pubsub|numsub", "-pubsub|numpat", "-pubsub|shardchannels", "-pubsub|shardnumsub",
}

func (d *dockerAPI) inspectRedisLogical(ctx context.Context, target adminTarget, plan logicalPlan) (logicalExistence, error) {
	if err := validateLogicalDatabase(plan.database); err != nil {
		return logicalExistence{}, err
	}
	if err := validateLogicalUser(plan.username, target.admin.Username); err != nil {
		return logicalExistence{}, err
	}
	readback, err := d.exec(ctx, adminExec{containerID: target.containerID, argv: redisClientArgs("--json", "ACL", "GETUSER", plan.username), env: []string{"REDISCLI_AUTH=" + target.admin.Password}, timeout: redisCommandTimeout})
	if err != nil {
		return logicalExistence{}, err
	}
	if readback.exitCode != 0 {
		return logicalExistence{}, errors.New("无法核对实例内已有的用户")
	}
	return parseRedisACL(readback.stdout, plan)
}

func parseRedisACL(output string, plan logicalPlan) (logicalExistence, error) {
	// redis-cli --json uses RESP3 maps. Pin the accepted shape to the
	// fields needed for evidence, including the absence of extra selectors.
	var reply *struct {
		Flags     []string
		Passwords []string
		Commands  string
		Keys      string
		Channels  string
		Selectors []json.RawMessage
	}
	if err := json.Unmarshal([]byte(output), &reply); err != nil {
		return logicalExistence{}, errors.New("无法核对实例内已有的用户")
	}
	if reply == nil {
		return logicalExistence{}, nil
	}
	if len(reply.Flags) == 0 || reply.Commands == "" || reply.Selectors == nil {
		return logicalExistence{}, errors.New("无法核对 Redis ACL 回执")
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(plan.password)))
	matches := plan.password != "" && slices.Contains(reply.Passwords, hash)
	return logicalExistence{
		User:            true,
		PasswordMatches: matches,
		PermissionsMatch: matches && len(reply.Passwords) == 1 && slices.Contains(reply.Flags, "on") &&
			!slices.Contains(reply.Flags, "off") && !slices.Contains(reply.Flags, "nopass") &&
			reply.Keys == "~"+plan.database+":*" && reply.Channels == "&"+plan.database+":*" &&
			len(reply.Selectors) == 0 && slices.Equal(strings.Fields(reply.Commands), redisTenantCommands),
	}, nil
}

// redisRepliedOK 判定一条只回 OK 的 ACL 命令确实成功。redis-cli 在服务端返回错误时退出码
// 仍是 0（Redis 7 实测），只能看正文。
func redisRepliedOK(result adminResult) bool {
	return result.exitCode == 0 && strings.EqualFold(strings.TrimSpace(result.stdout), "OK")
}
