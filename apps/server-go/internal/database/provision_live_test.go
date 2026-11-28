package database

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 真实镜像联调，只在显式开启时运行（ELYSIAN_TEST_DATABASE_LIVE=1）。只创建并清理自己的
// 临时容器：不发布端口、不挂宿主目录，内存与进程数受限。这里验证的是假 Engine 证明不了的
// 环境事实：官方镜像的管理员账号能否经容器内回环 TCP 登录、初始化阶段的临时实例是否被
// 探测避开、建库脚本与回读输出的真实格式、新用户的最小权限、Redis ACL 落盘后重启仍有效。
// 镜像须已在本机（mysql:8.0、redis:7），缺镜像时跳过而不代拉。

const (
	liveMySQLImage   = "mysql:8.0"
	liveMariaDBImage = "mariadb:10.11"
	liveRedisImage   = "redis:7"
	liveTestLabel    = "elysian.test"
	liveTestValue    = "database-live"
)

// liveSocketTransport 是只走 Docker 套接字的 Engine 传输器，形状与生产传输器一致。
type liveSocketTransport struct{ client *http.Client }

func newLiveSocketTransport(socket string) *liveSocketTransport {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		DisableCompression: true,
	}
	return &liveSocketTransport{client: &http.Client{Transport: transport}}
}

func (t *liveSocketTransport) newRequest(ctx context.Context, req seam.EngineRequest) (*http.Request, error) {
	target := "http://docker" + seam.EngineAPIPrefix + req.Path
	if len(req.Query) > 0 {
		target += "?" + req.Query.Encode()
	}
	var body io.Reader
	if len(req.Body) > 0 {
		body = bytes.NewReader(req.Body)
	}
	request, err := http.NewRequestWithContext(ctx, req.Method, target, body)
	if err != nil {
		return nil, err
	}
	if len(req.Body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

func (t *liveSocketTransport) Request(ctx context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	request, err := t.newRequest(ctx, req)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	response, err := t.client.Do(request)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	return seam.EngineResponse{Status: response.StatusCode, Body: raw}, err
}

func (t *liveSocketTransport) Stream(ctx context.Context, req seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	request, err := t.newRequest(ctx, req)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	response, err := t.client.Do(request)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	defer response.Body.Close()
	if onChunk == nil {
		_, err = io.Copy(io.Discard, response.Body)
		return seam.EngineResponse{Status: response.StatusCode}, err
	}
	buffer := make([]byte, 16<<10)
	for {
		n, err := response.Body.Read(buffer)
		if n > 0 {
			onChunk(buffer[:n])
		}
		if err == io.EOF {
			return seam.EngineResponse{Status: response.StatusCode}, nil
		}
		if err != nil {
			return seam.EngineResponse{}, err
		}
	}
}

func liveSocketPath() string {
	if socket := os.Getenv("ELYSIAN_TEST_DOCKER_EXEC_SOCKET"); socket != "" {
		return socket
	}
	return "/var/run/docker.sock"
}

func liveEngine(t *testing.T, method, path string, query url.Values, body any) seam.EngineResponse {
	t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	response, err := newLiveSocketTransport(liveSocketPath()).Request(context.Background(), seam.EngineRequest{Method: method, Path: path, Query: query, Body: raw, Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("Engine %s %s 失败：%v", method, path, err)
	}
	return response
}

func liveImagePresent(t *testing.T, ref string) bool {
	t.Helper()
	return liveEngine(t, http.MethodGet, "/images/"+url.PathEscape(ref)+"/json", nil, nil).Status == http.StatusOK
}

// liveContainer 创建并启动一个临时容器，用例结束时连同匿名卷一起删除。
func liveContainer(t *testing.T, transport seam.DockerTransport, spec map[string]any) string {
	t.Helper()
	raw, _ := json.Marshal(spec)
	response, err := transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodPost, Path: "/containers/create",
		Query: url.Values{"name": {"elysian-db-live-" + strings.ToLower(randomAdminPassword()[:12])}}, Body: raw, Timeout: 30 * time.Second})
	var created struct {
		ID string `json:"Id"`
	}
	if err != nil || response.Status != http.StatusCreated || json.Unmarshal(response.Body, &created) != nil || created.ID == "" {
		t.Fatalf("创建临时容器失败：%d %v %s", response.Status, err, response.Body)
	}
	t.Cleanup(func() {
		removed, err := transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodDelete, Path: "/containers/" + created.ID,
			Query: url.Values{"force": {"1"}, "v": {"1"}}, Timeout: 30 * time.Second})
		if err != nil || removed.Status != http.StatusNoContent {
			t.Errorf("清理临时容器失败：%d %v", removed.Status, err)
		}
	})
	response, err = transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodPost, Path: "/containers/" + created.ID + "/start", Timeout: 30 * time.Second})
	if err != nil || response.Status != http.StatusNoContent {
		t.Fatalf("启动临时容器失败：%d %v %s", response.Status, err, response.Body)
	}
	return created.ID
}

// liveExec 在容器内执行一条命令；命令结束但退出码非零不算测试框架错误。
func liveExec(t *testing.T, docker *dockerAPI, id string, argv, env []string) adminResult {
	t.Helper()
	result, err := docker.exec(context.Background(), adminExec{containerID: id, argv: argv, env: env, timeout: time.Minute})
	if err != nil {
		t.Fatalf("容器内命令未能确认退出：%v", err)
	}
	return result
}

func liveDatabaseAPI(t *testing.T) *dockerAPI {
	t.Helper()
	if os.Getenv("ELYSIAN_TEST_DATABASE_LIVE") != "1" {
		t.Skip("需要显式开启真实数据库镜像联调（ELYSIAN_TEST_DATABASE_LIVE=1）")
	}
	return newDockerAPI(newLiveSocketTransport(liveSocketPath()), nil)
}

func TestLiveMySQLProvisioningAgainstOfficialImage(t *testing.T) {
	for _, image := range []string{liveMySQLImage, liveMariaDBImage} {
		t.Run(image, func(t *testing.T) { liveMySQLProvisioning(t, image) })
	}
}

func liveMySQLProvisioning(t *testing.T, image string) {
	docker := liveDatabaseAPI(t)
	transport := docker.transport
	if !liveImagePresent(t, image) {
		t.Skipf("本机没有 %s 镜像", image)
	}
	// 与面板创建受管实例时相同：只给 root 密码，不设置 MYSQL_ROOT_HOST。
	admin := databaseSecret{Username: "root", Password: randomAdminPassword()}
	id := liveContainer(t, transport, map[string]any{
		"Image": image, "Labels": map[string]string{liveTestLabel: liveTestValue},
		"Env":        []string{"MYSQL_ROOT_PASSWORD=" + admin.Password},
		"HostConfig": map[string]any{"NetworkMode": "none", "Memory": int64(1 << 30), "PidsLimit": 512},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	started := time.Now()
	if err := docker.waitMySQLReady(ctx, id, admin); err != nil {
		t.Fatalf("实例未在限定时间内可登录（等待 %s）：%v", time.Since(started).Round(time.Second), err)
	}
	t.Logf("%s 首次可登录耗时 %s", image, time.Since(started).Round(time.Second))

	engine := engineMySQL
	if image == liveMariaDBImage {
		engine = engineMariaDB
	}
	target := adminTarget{containerID: id, engine: engine, admin: admin}
	if err := docker.verify(ctx, target); err != nil {
		t.Fatalf("正确凭据应通过核验：%v", err)
	}
	wrong := target
	wrong.admin.Password = "definitely-wrong-" + randomAdminPassword()
	if err := docker.verify(ctx, wrong); err == nil {
		t.Fatal("错误密码不得通过核验")
	}

	plan := logicalPlan{database: "shop", username: "shop_user", password: generateLogicalPassword()}
	if err := docker.createMySQLLogical(ctx, target, plan); err != nil {
		t.Fatalf("建库建用户失败：%v", err)
	}
	if err := docker.createMySQLLogical(ctx, target, plan); err != nil {
		t.Fatalf("重复执行建库应幂等：%v", err)
	}

	login := []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-u" + plan.username, "--batch", "--skip-column-names"}
	own := liveExec(t, docker, id, append(append([]string{}, login...), "-e", "USE shop; CREATE TABLE items(i INT); INSERT INTO items VALUES (1),(2); SELECT COUNT(*) FROM items;"), []string{"MYSQL_PWD=" + plan.password})
	if own.exitCode != 0 || strings.TrimSpace(own.stdout) != "2" {
		t.Fatalf("新用户应能在自己的库里建表读写：exit=%d out=%q err=%q", own.exitCode, own.stdout, own.stderr)
	}
	for name, statement := range map[string]string{
		"读别的库":     "USE mysql; SELECT 1;",
		"新建别的库":    "CREATE DATABASE sneak;",
		"改授权表所在的库": "UPDATE mysql.user SET User='intruder' WHERE User='root';",
	} {
		denied := liveExec(t, docker, id, append(append([]string{}, login...), "-e", statement), []string{"MYSQL_PWD=" + plan.password})
		if denied.exitCode == 0 || !strings.Contains(denied.stdout+denied.stderr, "denied") {
			t.Errorf("%s 应被拒绝：exit=%d out=%q err=%q", name, denied.exitCode, denied.stdout, denied.stderr)
		}
	}
	// Use two independent schemas so each partial_revokes setting is exercised
	// by a fresh grant. Neighbor schemas contain only fixture data.
	for _, mode := range []string{"off", "on"} {
		if engine == engineMariaDB && mode == "on" {
			continue
		}
		adminSQL := func(query string) adminResult {
			args := []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-uroot", "--batch", "--raw", "--skip-column-names", "-e", query}
			return liveExec(t, docker, id, args, mysqlAdminEnv(admin))
		}
		if engine == engineMySQL {
			if result := adminSQL("SET GLOBAL partial_revokes = " + mode); result.exitCode != 0 {
				t.Fatalf("无法设置临时测试实例的 partial_revokes=%s", mode)
			}
		}
		plan := logicalPlan{database: "tenant_" + mode, username: "tenant_" + mode + "_user", password: generateLogicalPassword()}
		neighbor := "tenantX" + mode
		if result := adminSQL("CREATE DATABASE " + neighbor + "; CREATE TABLE " + neighbor + ".fixture (id INT)"); result.exitCode != 0 {
			t.Fatal("无法创建隔离测试库")
		}
		if err := docker.createMySQLLogical(ctx, target, plan); err != nil {
			t.Fatalf("精确授权 %s: %v", mode, err)
		}
		facts, err := docker.inspectLogical(ctx, target, plan)
		if err != nil || !facts.PermissionsMatch {
			t.Fatalf("精确授权回读 %s: %+v %v", mode, facts, err)
		}
		args := []string{"mysql", "--protocol=TCP", "-h127.0.0.1", "-u" + plan.username, "--batch", "--skip-column-names", "-e"}
		env := []string{"MYSQL_PWD=" + plan.password}
		if got := liveExec(t, docker, id, append(append([]string(nil), args...), "CREATE TABLE "+plan.database+".fixture (id INT)"), env); got.exitCode != 0 {
			t.Fatalf("专属用户应能写入自己的库，partial_revokes=%s", mode)
		}
		if got := liveExec(t, docker, id, append(append([]string(nil), args...), "SELECT id FROM "+neighbor+".fixture"), env); got.exitCode == 0 || !strings.Contains(got.stderr, "denied") {
			t.Fatalf("专属用户访问名称相近的库应被拒绝，partial_revokes=%s", mode)
		}
	}

}

func TestLiveRedisACLUserAgainstOfficialImage(t *testing.T) {
	docker := liveDatabaseAPI(t)
	transport := docker.transport
	if !liveImagePresent(t, liveRedisImage) {
		t.Skipf("本机没有 %s 镜像", liveRedisImage)
	}
	// 与面板创建受管实例时相同：ACL 文件先写进 /data，再以 --aclfile 启动。
	admin := databaseSecret{Username: "default", Password: randomAdminPassword()}
	id := liveContainer(t, transport, map[string]any{
		"Image": liveRedisImage, "Cmd": redisACLCommand(admin.Password), "Labels": map[string]string{liveTestLabel: liveTestValue},
		"HostConfig": map[string]any{"NetworkMode": "none", "Memory": 128 << 20, "PidsLimit": 64},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := docker.waitRedisReady(ctx, id, admin); err != nil {
		t.Fatalf("Redis 实例未在限定时间内就绪：%v", err)
	}
	target := adminTarget{containerID: id, engine: engineRedis, admin: admin}
	if err := docker.verify(ctx, target); err != nil {
		t.Fatalf("正确凭据应通过核验：%v", err)
	}
	plan := logicalPlan{database: "shop", username: "shop_user", password: generateLogicalPassword()}
	if err := docker.createRedisACLUser(ctx, id, admin, plan); err != nil {
		t.Fatalf("ACL 用户创建失败：%v", err)
	}
	if err := docker.createRedisACLUser(ctx, id, admin, plan); err != nil {
		t.Fatalf("重复创建 ACL 用户应幂等：%v", err)
	}
	asUser := []string{"redis-cli", "-h", "127.0.0.1", "--no-auth-warning", "--raw", "--user", plan.username}
	userEnv := []string{"REDISCLI_AUTH=" + plan.password}
	// The write is a prerequisite for the read.
	for _, tc := range []struct {
		name string
		argv []string
		want string
	}{
		{"写自己前缀的键", []string{"SET", "shop:1", "a"}, "OK"},
		{"读自己前缀的键", []string{"GET", "shop:1"}, "a"},
		{"协议握手", []string{"HELLO", "3"}, "server"},
		{"开启事务", []string{"MULTI"}, "OK"},
		{"自己前缀的频道", []string{"PUBLISH", "shop:news", "hello"}, "0"},
	} {
		if got := liveExec(t, docker, id, append(append([]string{}, asUser...), tc.argv...), userEnv); got.exitCode != 0 || !strings.Contains(got.stdout, tc.want) {
			t.Errorf("%s 应被允许：exit=%d out=%q err=%q", tc.name, got.exitCode, got.stdout, got.stderr)
		}
	}
	// 隔离边界（真实 Redis 7 的 ACL DRYRUN 逐条核实）：其他前缀、整库清空、影响其他连接的
	// 命令、函数与脚本、不受 key 前缀约束的 RANDOMKEY 与 KEYS、管理命令、别的频道都必须被拒。
	for name, argv := range map[string][]string{
		"写别的前缀":    {"SET", "other:1", "b"},
		"读别的前缀":    {"GET", "other:1"},
		"清空整库":     {"FLUSHALL"},
		"清空当前库":    {"FLUSHDB"},
		"掐断其他连接":   {"CLIENT", "KILL", "ID", "1"},
		"暂停其他连接":   {"CLIENT", "PAUSE", "1000"},
		"列出其他连接":   {"CLIENT", "LIST"},
		"加载函数":     {"FUNCTION", "LOAD", "redis.register_function('f', function() return 1 end)"},
		"执行脚本":     {"EVAL", "return 1", "0"},
		"随机读别人的键名": {"RANDOMKEY"},
		"全量键名":     {"KEYS", "shop:*"},
		"全库游标":     {"SCAN", "0"},
		"全库计数":     {"DBSIZE"},
		"全局频道":     {"PUBSUB", "CHANNELS"},
		"频道订阅计数":   {"PUBSUB", "NUMSUB", "other:news"},
		"执行管理命令":   {"CONFIG", "GET", "aclfile"},
		"迁移数据到别处":  {"MIGRATE", "10.0.0.1", "6379", "shop:1", "0", "100"},
		"写入序列化数据":  {"RESTORE", "shop:2", "0", "AAAA"},
		"发到别的频道":   {"PUBLISH", "other:news", "hello"},
	} {
		if got := liveExec(t, docker, id, append(append([]string{}, asUser...), argv...), userEnv); !strings.Contains(got.stdout, "NOPERM") {
			t.Errorf("%s 应被拒绝：exit=%d out=%q err=%q", name, got.exitCode, got.stdout, got.stderr)
		}
	}
	// ACL SAVE 之后重启实例，用户与规则必须仍然有效。
	if restarted := liveEngine(t, http.MethodPost, "/containers/"+id+"/restart", url.Values{"t": {"10"}}, nil); restarted.Status != http.StatusNoContent {
		t.Fatalf("重启临时容器失败：%d %s", restarted.Status, restarted.Body)
	}
	if err := docker.waitRedisReady(ctx, id, admin); err != nil {
		t.Fatalf("重启后实例未就绪：%v", err)
	}
	if again := liveExec(t, docker, id, append(append([]string{}, asUser...), "GET", "shop:1"), userEnv); again.exitCode != 0 || strings.TrimSpace(again.stdout) != "a" {
		t.Fatalf("重启后 ACL 用户及其数据应仍然有效：exit=%d out=%q err=%q", again.exitCode, again.stdout, again.stderr)
	}
	if stillDenied := liveExec(t, docker, id, append(append([]string{}, asUser...), "SET", "other:2", "c"), userEnv); stillDenied.exitCode == 0 && !strings.Contains(stillDenied.stdout+stillDenied.stderr, "NOPERM") {
		t.Fatalf("重启后前缀隔离应仍然生效：exit=%d out=%q", stillDenied.exitCode, stillDenied.stdout)
	}
}
