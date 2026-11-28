package database

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// execCall 是一次被录制的容器内 exec 创建请求。
type execCall struct {
	path string
	argv []string
	env  []string
}

// execTransport 支撑容器内 exec 的假传输器：脚本按 argv 应答退出码与标准输出。
type execTransport struct {
	calls     []execCall
	script    func(call execCall) (exitCode int, stdout string)
	execID    string
	running   bool
	createErr bool
	streamErr error
	streams   int
	// pending 是本次 exec 创建时求得的应答，流与退出查询共用，脚本只求值一次。
	pendingCode int
	pendingOut  string
}

func newExecTransport(script func(execCall) (int, string)) *execTransport {
	return &execTransport{script: script, execID: strings.Repeat("e", 64)}
}

func (t *execTransport) Request(_ context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	switch {
	case req.Method == "POST" && strings.HasSuffix(req.Path, "/exec"):
		if t.createErr {
			return seam.EngineResponse{Status: 500}, nil
		}
		var body struct {
			Cmd []string `json:"Cmd"`
			Env []string `json:"Env"`
		}
		if err := json.Unmarshal(req.Body, &body); err != nil {
			return seam.EngineResponse{}, err
		}
		call := execCall{path: req.Path, argv: body.Cmd, env: body.Env}
		t.calls = append(t.calls, call)
		t.pendingCode, t.pendingOut = t.script(call)
		return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + t.execID + `"}`)}, nil
	case req.Method == "GET" && strings.HasPrefix(req.Path, "/exec/"):
		running := map[bool]string{true: "true", false: "false"}[t.running]
		return seam.EngineResponse{Status: 200, Body: []byte(`{"Running":` + running + `,"ExitCode":` + strconv.Itoa(t.pendingCode) + `,"ContainerID":"` + testContainerID + `"}`)}, nil
	}
	return seam.EngineResponse{Status: 404}, nil
}

func (t *execTransport) Stream(_ context.Context, _ seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	t.streams++
	if t.streamErr != nil {
		return seam.EngineResponse{}, t.streamErr
	}
	stdout := t.pendingOut
	frame := make([]byte, 8)
	frame[0] = 1
	binary.BigEndian.PutUint32(frame[4:], uint32(len(stdout)))
	onChunk(frame)
	if stdout != "" {
		onChunk([]byte(stdout))
	}
	return seam.EngineResponse{Status: 200}, nil
}

// fixedClock 让就绪等待的等待时间可控：sleep 推进虚拟时钟。
func fixedClock(docker *dockerAPI) *time.Time {
	clock := time.Unix(0, 0)
	docker.now = func() time.Time { return clock }
	docker.sleep = func(context.Context, time.Duration) error {
		clock = clock.Add(2 * time.Second)
		return nil
	}
	return &clock
}

const (
	adminSecret = "admin-s3cret-value"
	userSecret  = "user-s3cret-value"
)

var (
	mysqlGrantLine = "GRANT ALL PRIVILEGES ON `shop`.* TO `shop_user`@`%`"
	rootAdmin      = databaseSecret{Username: "root", Password: adminSecret}
)

func TestAdminExecCarriesOutputAndExitCode(t *testing.T) {
	transport := newExecTransport(func(execCall) (int, string) { return 0, "ok" })
	docker := newDockerAPI(transport, nil)
	result, err := docker.exec(context.Background(), adminExec{
		containerID: testContainerID, argv: []string{"mysql", "-e", "SELECT 1"}, env: []string{"MYSQL_PWD=" + adminSecret}, timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.exitCode != 0 || result.stdout != "ok" {
		t.Fatalf("exec 结果不符：%+v", result)
	}
	if len(transport.calls) != 1 || transport.calls[0].path != "/containers/"+testContainerID+"/exec" {
		t.Fatalf("exec 应针对目标容器创建：%+v", transport.calls)
	}
}

func TestAdminExecRejectsUnconfirmedExit(t *testing.T) {
	for name, mutate := range map[string]func(*execTransport){
		"创建被拒": func(t *execTransport) { t.createErr = true },
		"仍在运行": func(t *execTransport) { t.running = true },
	} {
		transport := newExecTransport(func(execCall) (int, string) { return 0, "" })
		mutate(transport)
		docker := newDockerAPI(transport, nil)
		if _, err := docker.exec(context.Background(), adminExec{containerID: testContainerID, argv: []string{"true"}, timeout: time.Second}); err == nil {
			t.Errorf("%s：退出状态未确认时不得当作成功", name)
		}
	}
}

func TestWaitMySQLReadyRetriesWithPasswordOnlyInEnvironment(t *testing.T) {
	attempts := 0
	transport := newExecTransport(func(execCall) (int, string) {
		attempts++
		if attempts < 3 {
			return 1, "ERROR 2002 (HY000): Can't connect to server on '127.0.0.1'"
		}
		return 0, "1"
	})
	docker := newDockerAPI(transport, nil)
	fixedClock(docker)
	if err := docker.waitMySQLReady(context.Background(), testContainerID, rootAdmin); err != nil {
		t.Fatalf("就绪后应返回：%v", err)
	}
	if attempts != 3 {
		t.Fatalf("应重试到就绪为止，实际 %d 次", attempts)
	}
	call := transport.calls[0]
	joined := strings.Join(call.argv, " ")
	for _, want := range []string{"--protocol=TCP", "-h127.0.0.1", "-P3306", "-uroot"} {
		if !strings.Contains(joined, want) {
			t.Errorf("就绪探测应经容器内回环 TCP 连接，缺少 %q：%s", want, joined)
		}
	}
	if strings.Contains(joined, adminSecret) {
		t.Fatalf("管理员密码不得出现在命令参数里：%s", joined)
	}
	if len(call.env) != 1 || call.env[0] != "MYSQL_PWD="+adminSecret {
		t.Fatalf("管理员密码只应经环境变量传入：%v", call.env)
	}
}

func TestWaitMySQLReadyGivesUpAtDeadline(t *testing.T) {
	attempts := 0
	transport := newExecTransport(func(execCall) (int, string) { attempts++; return 1, "" })
	docker := newDockerAPI(transport, nil)
	fixedClock(docker)
	err := docker.waitMySQLReady(context.Background(), testContainerID, rootAdmin)
	if err == nil || !strings.Contains(err.Error(), "未就绪") {
		t.Fatalf("限定时间内未就绪应报错：%v", err)
	}
	if attempts != 61 { // 0s 起每 2s 一次，直到 120s 的最后一次
		t.Errorf("重试次数不符：%d", attempts)
	}
}

func TestWaitMySQLReadyStopsWhenContextEnds(t *testing.T) {
	transport := newExecTransport(func(execCall) (int, string) { return 1, "" })
	docker := newDockerAPI(transport, nil)
	ctx, cancel := context.WithCancel(context.Background())
	docker.sleep = func(context.Context, time.Duration) error { cancel(); return ctx.Err() }
	if err := docker.waitMySQLReady(ctx, testContainerID, rootAdmin); err == nil {
		t.Fatal("上下文结束后不得继续等待")
	}
}

func TestCreateMySQLLogicalKeepsEverySecretOffArgv(t *testing.T) {
	transport := newExecTransport(func(execCall) (int, string) {
		return 0, "1:1\n" + mysqlGrantLine + "\n"
	})
	docker := newDockerAPI(transport, nil)
	err := docker.createMySQLLogical(context.Background(), adminTarget{containerID: testContainerID, engine: engineMySQL, admin: rootAdmin}, logicalPlan{database: "shop", username: "shop_user", password: userSecret})
	if err != nil {
		t.Fatal(err)
	}
	if len(transport.calls) != 1 {
		t.Fatalf("建库建用户应是一次 exec：%+v", transport.calls)
	}
	call := transport.calls[0]
	joined := strings.Join(call.argv, " ")
	if strings.Contains(joined, adminSecret) || strings.Contains(joined, userSecret) {
		t.Fatalf("任何密码都不得出现在命令参数里：%s", joined)
	}
	script := ""
	admin := ""
	for _, entry := range call.env {
		if value, ok := strings.CutPrefix(entry, "MYSQL_SCRIPT="); ok {
			script = value
		}
		if value, ok := strings.CutPrefix(entry, "MYSQL_ADMIN_USER="); ok {
			admin = value
		}
	}
	if admin != "root" || !hasEnv(call.env, "MYSQL_PWD="+adminSecret) {
		t.Fatalf("管理员身份只应经环境变量传入：%v", call.env)
	}
	// 脚本幂等：重试不会因为库或用户已存在而失败，并且把密码对齐到登记值。
	for _, want := range []string{
		"CREATE DATABASE IF NOT EXISTS `shop`",
		"CREATE USER IF NOT EXISTS 'shop_user'@'%' IDENTIFIED BY '" + userSecret + "'",
		"ALTER USER 'shop_user'@'%' IDENTIFIED BY '" + userSecret + "'",
		"GRANT ALL PRIVILEGES ON `shop`.* TO 'shop_user'@'%'",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("脚本缺少 %q：%s", want, script)
		}
	}
}

func TestCreateMySQLLogicalRejectsUnconfirmedResult(t *testing.T) {
	for name, script := range map[string]func(execCall) (int, string){
		"非零退出":   func(execCall) (int, string) { return 1, "ERROR 1064 (42000): You have an error in your SQL syntax" },
		"库或用户缺失": func(execCall) (int, string) { return 0, "0:1\n" + mysqlGrantLine + "\n" },
		"授权未生效":  func(execCall) (int, string) { return 0, "1:1\n" },
	} {
		transport := newExecTransport(script)
		docker := newDockerAPI(transport, nil)
		err := docker.createMySQLLogical(context.Background(), adminTarget{containerID: testContainerID, engine: engineMySQL, admin: rootAdmin}, logicalPlan{database: "shop", username: "shop_user", password: userSecret})
		if err == nil {
			t.Errorf("%s：结果未确认时不得当作成功", name)
			continue
		}
		if strings.Contains(err.Error(), userSecret) || strings.Contains(err.Error(), adminSecret) {
			t.Errorf("%s：错误文案不得带出密码：%v", name, err)
		}
	}
}

func TestLogicalNamesAreValidatedBeforeAnyCommand(t *testing.T) {
	for _, name := range []string{"shop", "order", "a1_b", "X"} {
		if err := validateLogicalDatabase(name); err != nil {
			t.Errorf("库名 %q 应合法：%v", name, err)
		}
	}
	for _, name := range []string{"", "1abc", "a-b", "a b", "shop;drop", "选", strings.Repeat("a", 65), "a'b"} {
		if err := validateLogicalDatabase(name); err == nil {
			t.Errorf("库名 %q 应被拒绝", name)
		}
	}
	for _, name := range []string{"shop_user", "app1"} {
		if err := validateLogicalUser(name, "root"); err != nil {
			t.Errorf("用户名 %q 应合法：%v", name, err)
		}
	}
	for _, name := range []string{"", "root", "mysql.sys", "mysql.session", "mariadb.sys", "shop-user", strings.Repeat("a", 33), "admin"} {
		if err := validateLogicalUser(name, "admin"); err == nil {
			t.Errorf("用户名 %q 应被拒绝", name)
		}
	}
}

func TestDefaultLogicalUsernameStaysWithinMySQLLimit(t *testing.T) {
	if got := defaultLogicalUsername("shop"); got != "shop_user" {
		t.Errorf("缺省用户名不符：%s", got)
	}
	long := strings.Repeat("a", 60)
	got := defaultLogicalUsername(long)
	if len(got) > 32 || !strings.HasPrefix(got, "u_a") {
		t.Errorf("长库名的缺省用户名应截断到 32 字符以内：%s", got)
	}
}

func hasEnv(env []string, want string) bool {
	for _, entry := range env {
		if entry == want {
			return true
		}
	}
	return false
}

// 系统库不能作为逻辑库名：否则 GRANT ALL ON mysql.* 会把授权表交给新用户。
func TestSchemaDatabaseNamesRejectSystemDatabases(t *testing.T) {
	for _, name := range []string{"mysql", "sys", "information_schema", "performance_schema", "Performance_Schema", "MYSQL"} {
		if err := validateSchemaDatabase(name); err == nil || !strings.Contains(err.Error(), "系统保留") {
			t.Errorf("系统库名 %q 应被拒绝：%v", name, err)
		}
	}
	for _, name := range []string{"shop", "orders", "mysqlshop", "system"} {
		if err := validateSchemaDatabase(name); err != nil {
			t.Errorf("普通库名 %q 应通过：%v", name, err)
		}
	}
}

// 建库 SQL 经标准输入交给 mysql：经 -e "$变量" 展开后 SQL（含新用户密码）会进入容器内
// mysql 进程的参数，宿主机上经 /proc 可读；printf 是内建命令，不产生带参数的进程。
func TestCreateMySQLLogicalFeedsSQLThroughStdinNotArguments(t *testing.T) {
	transport := newExecTransport(func(execCall) (int, string) { return 0, "1:1\n" + mysqlGrantLine + "\n" })
	docker := newDockerAPI(transport, nil)
	if err := docker.createMySQLLogical(context.Background(), adminTarget{containerID: testContainerID, engine: engineMySQL, admin: rootAdmin}, logicalPlan{database: "shop", username: "shop_user", password: userSecret}); err != nil {
		t.Fatal(err)
	}
	shell := strings.Join(transport.calls[0].argv, " ")
	if !strings.Contains(shell, `printf '%s' "$MYSQL_SCRIPT" |`) {
		t.Fatalf("SQL 应由内建 printf 经标准输入交给 mysql：%s", shell)
	}
	if strings.Contains(shell, "-e ") {
		t.Fatalf("不得再用 -e 把 SQL 放进 mysql 的参数：%s", shell)
	}
}

// 受理前的只读核对：报告实例里是否已有同名的库与用户，以及已有用户能否用登记密码登录。
func TestInspectMySQLLogicalReportsExistingObjects(t *testing.T) {
	for name, tc := range map[string]struct {
		existenceReply string
		userExit       int
		want           logicalExistence
	}{
		"实例里没有":      {"0:0", 1, logicalExistence{}},
		"只有库":        {"1:0", 1, logicalExistence{Database: true}},
		"库和用户都有":     {"1:1", 1, logicalExistence{Database: true, User: true}},
		"库和用户都是面板建的": {"1:1", 0, logicalExistence{Database: true, User: true, PasswordMatches: true, PermissionsMatch: true}},
	} {
		transport := newExecTransport(func(call execCall) (int, string) {
			joined := strings.Join(call.argv, " ")
			switch {
			case strings.Contains(joined, "information_schema.SCHEMATA"):
				return 0, tc.existenceReply
			case strings.Contains(joined, "-ushop_user"):
				return tc.userExit, "shop_user@%"
			case strings.Contains(joined, "SHOW GRANTS"):
				return 0, mysqlGrantLine
			}
			return 0, "1"
		})
		docker := newDockerAPI(transport, nil)
		got, err := docker.inspectLogical(context.Background(), adminTarget{containerID: testContainerID, engine: engineMySQL, admin: rootAdmin}, logicalPlan{database: "shop", username: "shop_user", password: userSecret})
		if err != nil || got != tc.want {
			t.Errorf("%s：核对结果不符：got %+v want %+v err %v", name, got, tc.want, err)
		}
		for _, call := range transport.calls {
			if strings.Contains(strings.Join(call.argv, " "), userSecret) || strings.Contains(strings.Join(call.argv, " "), adminSecret) {
				t.Errorf("%s：核对命令的参数里不得出现密码：%v", name, call.argv)
			}
		}
	}
}

func TestAdminMutationJournalsBeforeStartAndPreservesUnconfirmedExit(t *testing.T) {
	for _, mode := range []string{"journal", "stream", "still-running", "finished"} {
		t.Run(mode, func(t *testing.T) {
			transport := newExecTransport(func(execCall) (int, string) { return 0, "OK" })
			if mode == "stream" {
				transport.streamErr = errors.New("断流")
			}
			transport.running = mode == "still-running"
			docker := newDockerAPI(transport, nil)
			var records []provisionWrite
			ctx := context.WithValue(t.Context(), provisionJournalKey{}, func(write provisionWrite) error {
				records = append(records, write)
				if mode == "journal" {
					return errors.New("落盘失败")
				}
				return nil
			})
			_, err := docker.exec(ctx, adminExec{containerID: testContainerID, argv: []string{"mysql"}, writeStep: "mysql-logical"})
			if (err == nil) != (mode == "finished") || len(records) == 0 || records[0].ExecID != transport.execID {
				t.Fatalf("证据与结果不符：%+v %v", records, err)
			}
			if mode == "journal" && transport.streams != 0 || mode != "journal" && transport.streams != 1 {
				t.Fatalf("落盘前不能启动，streams=%d", transport.streams)
			}
			if records[len(records)-1].Finished != (mode == "finished") {
				t.Fatalf("没有确认退出不得写结束证据：%+v", records)
			}
		})
	}
}
