package database

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const redisAdminSecret = "redis-admin-secret"

func redisAdmin() databaseSecret {
	return databaseSecret{Username: "default", Password: redisAdminSecret}
}

// Redis 就绪：经容器内回环 PING；密码只经环境变量传入。
func TestWaitRedisReadyUsesPasswordFromEnvironmentOnly(t *testing.T) {
	attempts := 0
	transport := newExecTransport(func(execCall) (int, string) {
		attempts++
		if attempts < 2 {
			return 1, "Could not connect to Redis at 127.0.0.1:6379: Connection refused"
		}
		return 0, "PONG"
	})
	docker := newDockerAPI(transport, nil)
	fixedClock(docker)
	if err := docker.waitRedisReady(context.Background(), testContainerID, redisAdmin()); err != nil {
		t.Fatalf("就绪后应返回：%v", err)
	}
	call := transport.calls[0]
	joined := strings.Join(call.argv, " ")
	if strings.Contains(joined, redisAdminSecret) {
		t.Fatalf("Redis 密码不得出现在命令参数里：%s", joined)
	}
	if !hasEnv(call.env, "REDISCLI_AUTH="+redisAdminSecret) {
		t.Fatalf("Redis 密码应只经环境变量传入：%v", call.env)
	}
	for _, want := range []string{"redis-cli", "-h 127.0.0.1", "PING"} {
		if !strings.Contains(joined, want) {
			t.Errorf("就绪探测缺少 %q：%s", want, joined)
		}
	}
}

// ACL 用户：按 key 前缀隔离，命令白名单不含危险命令；密码只经环境变量。
func TestCreateRedisACLUserIsolatesPrefixAndKeepsSecretOffArgv(t *testing.T) {
	const userSecret = "acl-user-secret"
	transport := newExecTransport(func(call execCall) (int, string) {
		joined := strings.Join(call.argv, " ")
		if strings.Contains(joined, "CONFIG GET aclfile") {
			return 0, "aclfile\n/data/users.acl\n"
		}
		if strings.Contains(joined, "ACL GETUSER") {
			// --raw 的真实输出（Redis 7 实测）：字段名各占一行，flags 逐项一行，commands 一整行。
			return 0, redisReadback("on", "~shop:*", "&shop:*", sha256Hex(userSecret))
		}
		return 0, "OK"
	})
	docker := newDockerAPI(transport, nil)
	if err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: userSecret}); err != nil {
		t.Fatalf("ACL 用户应创建成功：%v", err)
	}
	var rules, save *execCall
	for i := range transport.calls {
		call := &transport.calls[i]
		joined := strings.Join(call.argv, " ")
		if hasArg(call.argv, "SETUSER") && hasArg(call.argv, "resetkeys") {
			rules = call
		}
		if hasArg(call.argv, "SAVE") && hasArg(call.argv, "ACL") {
			save = call
		}
		if strings.Contains(joined, userSecret) || strings.Contains(joined, redisAdminSecret) {
			t.Fatalf("密码不得出现在命令参数里：%s", joined)
		}
	}
	if rules == nil {
		t.Fatal("未执行带规则的 ACL SETUSER")
	}
	// 规则集按真实 Redis 7 的 ACL DRYRUN 实测确定（见 provision_live_test.go）。
	for _, flag := range []string{
		"resetkeys", "~shop:*", "resetchannels", "&shop:*",
		"-@all", "+@read", "+@write", "+@transaction", "+@pubsub",
		"+hello", "+ping", "+auth", "+select", "+quit", "+reset", "+echo", "+client|setname", "+client|setinfo", "+client|getname", "+client|id",
		"-@dangerous", "-@scripting", "-randomkey",
	} {
		if !hasArg(rules.argv, flag) {
			t.Errorf("ACL 规则缺少 %q：%v", flag, rules.argv)
		}
	}
	// 不整类授予 @connection：其中含 CLIENT KILL／CLIENT PAUSE 等会影响其他租户连接的命令。
	// 类别名也不得出现不存在的 @ping／@hello（它们是命令，不是类别）。
	for _, forbidden := range []string{"+@connection", "+@ping", "+@hello"} {
		if hasArg(rules.argv, forbidden) {
			t.Errorf("ACL 规则不得包含 %q：%v", forbidden, rules.argv)
		}
	}
	if save == nil {
		t.Fatal("ACL 用户必须落盘（ACL SAVE）")
	}
	// 管理员密码经环境变量传入，用户密码另经环境变量与标准输入，都不进 argv。
	if !hasEnvPrefix(rules.env, "REDISCLI_AUTH=") {
		t.Fatalf("管理员密码应只经环境变量传入：%v", rules.env)
	}
	// 重试幂等：对同一密码重复执行 >密码 会被 Redis 以「密码已存在」拒绝，设密码前必须 resetpass。
	setPassword := ""
	for _, call := range transport.calls {
		if hasEnvPrefix(call.env, "ACL_PASSWORD="+userSecret) {
			setPassword = strings.Join(call.argv, " ")
		}
	}
	if setPassword == "" {
		t.Fatal("用户密码应经环境变量交给 redis-cli，而不是 argv")
	}
	if !strings.Contains(setPassword, "resetpass >%s") {
		t.Fatalf("设密码的命令应先 resetpass 再写入，重试才幂等：%s", setPassword)
	}
}

// 前置条件不具备时不执行任何变更：ACL 不可用或没有 aclfile。
func TestCreateRedisACLUserRefusesWithoutPersistedACLFile(t *testing.T) {
	for name, output := range map[string]string{
		"ACL 不支持":    "ERR unknown command 'ACL'",
		"没有 aclfile": "aclfile\n\n",
	} {
		transport := newExecTransport(func(call execCall) (int, string) {
			if strings.Contains(strings.Join(call.argv, " "), "CONFIG GET aclfile") {
				return 0, output
			}
			return 0, "OK"
		})
		docker := newDockerAPI(transport, nil)
		err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: "x"})
		if err == nil || !strings.Contains(err.Error(), "ACL") {
			t.Errorf("%s：应明确拒绝：%v", name, err)
		}
		for _, call := range transport.calls {
			joined := strings.Join(call.argv, " ")
			if strings.Contains(joined, "ACL SETUSER") || strings.Contains(joined, "ACL SAVE") {
				t.Errorf("%s：前置检查不通过时不得变更：%s", name, joined)
			}
		}
	}
}

// redis-cli 在服务端返回错误时退出码仍是 0：只看退出码会把「规则被拒」当成成功。
func TestCreateRedisACLUserTreatsErrorRepliesAsFailure(t *testing.T) {
	for name, errored := range map[string]string{
		"规则命令被拒": "ACL SETUSER",
		"密码命令被拒": "resetpass",
		"落盘被拒":   "ACL SAVE",
	} {
		transport := newExecTransport(func(call execCall) (int, string) {
			joined := strings.Join(call.argv, " ")
			switch {
			case strings.Contains(joined, "CONFIG GET aclfile"):
				return 0, "aclfile\n/data/users.acl\n"
			case strings.Contains(joined, "ACL GETUSER"):
				return 0, redisReadback("on", "~shop:*", "&shop:*", sha256Hex("x"))
			case errored == "ACL SETUSER" && hasArg(call.argv, "SETUSER") && hasArg(call.argv, "resetkeys"),
				errored == "resetpass" && strings.Contains(joined, "resetpass"),
				errored == "ACL SAVE" && hasArg(call.argv, "SAVE"):
				return 0, "ERR Error in ACL SETUSER modifier: rejected by the server"
			}
			return 0, "OK"
		})
		docker := newDockerAPI(transport, nil)
		err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: "x"})
		if err == nil {
			t.Errorf("%s：服务端返回错误时不得当作成功", name)
		}
	}
}

// 回读必须核对用户确实处于启用状态：输出里的 commands 等词本身含 on，不能用子串糊弄。
func TestCreateRedisACLUserRejectsDisabledReadback(t *testing.T) {
	transport := newExecTransport(func(call execCall) (int, string) {
		joined := strings.Join(call.argv, " ")
		if strings.Contains(joined, "CONFIG GET aclfile") {
			return 0, "aclfile\n/data/users.acl\n"
		}
		if strings.Contains(joined, "ACL GETUSER") {
			return 0, redisReadback("off", "~shop:*", "&shop:*", sha256Hex("x"))
		}
		return 0, "OK"
	})
	docker := newDockerAPI(transport, nil)
	if err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: "x"}); err == nil {
		t.Fatal("回读显示用户未启用时不得当作创建成功")
	}
}

// 回读没有目标用户时不算成功。
func TestCreateRedisACLUserRequiresReadback(t *testing.T) {
	transport := newExecTransport(func(call execCall) (int, string) {
		joined := strings.Join(call.argv, " ")
		if strings.Contains(joined, "CONFIG GET aclfile") {
			return 0, "aclfile\n/data/users.acl\n"
		}
		if strings.Contains(joined, "ACL GETUSER") {
			return 1, "ERR no such user"
		}
		return 0, "OK"
	})
	docker := newDockerAPI(transport, nil)
	if err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: "x"}); err == nil {
		t.Fatal("回读失败不得当作创建成功")
	}
}

// 管理员身份必须按引擎取：Redis 用 default，MySQL 用 root。
func TestDefaultAdminUsernamePerEngine(t *testing.T) {
	for engine, want := range map[string]string{engineMySQL: "root", engineMariaDB: "root", engineRedis: "default"} {
		if got := defaultAdminUsername(engine, nil); got != want {
			t.Errorf("%s 的管理员用户名 = %q，want %q", engine, got, want)
		}
	}
}

// Redis 部署走 ACL 用户：key 前缀缺省取库名，实例复用与 MySQL 同一套决策。
func TestPlanProvisionReusesRedisInstance(t *testing.T) {
	service := newInstanceService([]instanceSpec{
		{id: hexID("4"), ref: "redis:7.4", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "Redis", "elysian.database.version": "7.4"}},
	}, []databaseRecord{registeredRow("row-4", engineRedis, "7.4", hexID("4"))}, nil, ampleMemory())
	plan, err := service.PlanProvision(context.Background(), engineRedis, "7", "", false)
	if err != nil || plan.Action != planReuse {
		t.Fatalf("版本匹配的 Redis 实例应复用：%+v %v", plan, err)
	}
}

// Redis 部署在实例上建 ACL 用户，登记为 acl-user 并记下 key 前缀。
func TestSubmitProvisionCreatesRedisACLUser(t *testing.T) {
	fixture := newProvisionFixture(t, []instanceSpec{
		{id: hexID("4"), ref: "redis:7.4", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "Redis", "elysian.database.version": "7.4"}},
	}, []databaseRecord{registeredRow("row-4", engineRedis, "7.4", hexID("4"))}, nil, ampleMemory())
	fixture.admin.logicalFn = nil
	input := ProvisionInput{Engine: engineRedis, Version: "7.4", Database: "cart", RequestID: strings.Repeat("4", 64)}
	task, err := fixture.facade.SubmitProvision(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	done := waitProvision(t, fixture, task.ID)
	if done.State != "succeeded" {
		t.Fatalf("Redis 部署应成功：%+v", done)
	}
	if len(fixture.admin.logicalPlan) != 1 || fixture.admin.logicalPlan[0].database != "cart" {
		t.Fatalf("应以库名作为 key 前缀执行：%+v", fixture.admin.logicalPlan)
	}
	rows, _ := fixture.registry.list()
	logical := rows[0].Logical
	if len(logical) != 1 || logical[0].Kind != logicalKindACLUser || logical[0].KeyPrefix != "cart" || logical[0].State != logicalStateActive {
		t.Fatalf("Redis 用户应登记为 acl-user 并记下前缀：%+v", logical)
	}
	if target := fixture.admin.targets[0]; target.admin.Username != "default" {
		t.Fatalf("Redis 应以 default 管理员执行：%+v", target)
	}
}

// Redis 引擎不再被部署入口拒绝。
func TestSubmitProvisionAcceptsRedisAndRejectsUnsupportedEngines(t *testing.T) {
	fixture := newProvisionFixture(t, []instanceSpec{
		{id: hexID("4"), ref: "redis:7.4", running: true, labels: map[string]string{"elysian.managed": "true", "elysian.database.engine": "Redis", "elysian.database.version": "7.4"}},
	}, []databaseRecord{registeredRow("row-4", engineRedis, "7.4", hexID("4"))}, nil, ampleMemory())
	if _, err := fixture.facade.SubmitProvision(context.Background(), ProvisionInput{Engine: "PostgreSQL", Version: "16", Database: "shop", RequestID: strings.Repeat("5", 64)}); err == nil {
		t.Fatal("不支持的引擎应被拒绝")
	}
}

// Redis 的登记名也要校验成合法标识符。
func TestValidateLogicalNamesForRedisPrefix(t *testing.T) {
	if err := validateLogicalDatabase("cart"); err != nil {
		t.Fatalf("合法前缀应通过：%v", err)
	}
	if err := validateLogicalDatabase("cart:*"); err == nil {
		t.Fatal("前缀里不得带通配符等元字符")
	}
}

// redisReadback uses the structured Redis 7 ACL reply.
func redisReadback(flags, keyPattern, channelPattern, passwordHash string) string {
	raw, _ := json.Marshal(map[string]any{"flags": []string{flags, "sanitize-payload"},
		"passwords": []string{passwordHash}, "commands": strings.Join(redisTenantCommands, " "),
		"keys": keyPattern, "channels": channelPattern, "selectors": []any{}})
	return string(raw)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", sum)
}

// 回读里的密码哈希必须与登记的密码一致：规则对了但密码没设上，登记的凭据就是废的。
func TestCreateRedisACLUserRejectsReadbackWithUnexpectedPassword(t *testing.T) {
	transport := newExecTransport(func(call execCall) (int, string) {
		joined := strings.Join(call.argv, " ")
		switch {
		case strings.Contains(joined, "CONFIG GET aclfile"):
			return 0, "aclfile\n/data/users.acl\n"
		case strings.Contains(joined, "ACL GETUSER"):
			return 0, redisReadback("on", "~shop:*", "&shop:*", sha256Hex("some-other-password"))
		}
		return 0, "OK"
	})
	docker := newDockerAPI(transport, nil)
	if err := docker.createRedisACLUser(context.Background(), testContainerID, redisAdmin(), logicalPlan{database: "shop", username: "shop_user", password: "x"}); err == nil {
		t.Fatal("回读的密码哈希与登记密码不一致时不得当作创建成功")
	}
}

func hasArg(argv []string, want string) bool {
	for _, arg := range argv {
		if arg == want {
			return true
		}
	}
	return false
}

func hasEnvPrefix(env []string, prefix string) bool {
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return true
		}
	}
	return false
}

// Redis 的只读核对：用户是否存在、登记密码是否已设在它身上。
func TestInspectRedisLogicalReportsExistingUser(t *testing.T) {
	for name, tc := range map[string]struct {
		reply string
		want  logicalExistence
	}{
		"用户不存在":     {"null", logicalExistence{}},
		"别人的同名用户":   {redisReadback("on", "~other:*", "&other:*", sha256Hex("another-password")), logicalExistence{User: true}},
		"面板建的待确认用户": {redisReadback("on", "~shop:*", "&shop:*", sha256Hex(userSecret)), logicalExistence{User: true, PasswordMatches: true, PermissionsMatch: true}},
	} {
		transport := newExecTransport(func(execCall) (int, string) { return 0, tc.reply })
		docker := newDockerAPI(transport, nil)
		got, err := docker.inspectLogical(context.Background(), adminTarget{containerID: testContainerID, engine: engineRedis, admin: redisAdmin()}, logicalPlan{database: "shop", username: "shop_user", password: userSecret})
		if err != nil || got != tc.want {
			t.Errorf("%s：核对结果不符：got %+v want %+v err %v", name, got, tc.want, err)
		}
	}
}
