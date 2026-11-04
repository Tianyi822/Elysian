package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

var (
	agentServiceImage  = "docker.io/library/mysql:8.4@sha256:" + strings.Repeat("a", 64)
	agentServiceDigest = strings.Repeat("a", 64)
)

// mirrorImageScript 覆盖「本机清单解析」路径：镜像源拉取后重打标签的镜像，
// RepoDigests 保留源站命名；实现必须经 /images/json 与按 ID inspect 核验，
// 不得请求「名称:标签@sha256:摘要」组合引用（Engine 按名字解析必 404）。
func mirrorImageScript(t *testing.T, createBody *string, imageID string, repoTags string) engineScript {
	t.Helper()
	return func(call engineCall) (int, string, bool) {
		containerID := strings.Repeat("c", 64)
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/mysql-main/json":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			return http.StatusOK, serviceContainerInspectBody(), true
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, fmt.Sprintf(`[{"Id":"sha256:%s"}]`, imageID), true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, fmt.Sprintf(`{"Id":"sha256:%s","Size":1103000000,"Created":"2026-11-04T00:00:00Z","RepoTags":[%s],"RepoDigests":["docker.1panel.live/library/mysql@sha256:%s"],"Config":{}}`, imageID, repoTags, strings.Repeat("a", 64)), true
		case call.Method == http.MethodPost && call.Path == "/volumes/create":
			return http.StatusCreated, `{"Name":"elysian-agent-0-req-1"}`, true
		case call.Method == http.MethodPost && call.Path == "/containers/create":
			*createBody = call.Body
			return http.StatusCreated, fmt.Sprintf(`{"Id":"%s","Warnings":[]}`, containerID), true
		case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}
}

func TestCreateServiceResolvesMirrorPulledImageByLocalList(t *testing.T) {
	imageID := strings.Repeat("b", 64)
	var createBody string
	facade := newServiceFacade(t, mirrorImageScript(t, &createBody, imageID, `"mysql:8.4"`), &recordingPortOpener{})
	result, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "any-host", Port: 3306, HostPort: 13306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result == nil {
		t.Fatal("回执为空")
	}
	if !strings.Contains(createBody, `"Image":"sha256:`+imageID+`"`) {
		t.Fatalf("创建体未用镜像 ID 钉死：%s", createBody)
	}
	if strings.Contains(createBody, `"HostIP"`) || !strings.Contains(createBody, `"HostIp":"0.0.0.0"`) {
		t.Fatalf("端口绑定字段必须是 HostIp：%s", createBody)
	}
}

func TestCreateServiceRejectsUnknownDigestViaLocalList(t *testing.T) {
	imageID := strings.Repeat("b", 64)
	var createBody string
	facade := newServiceFacade(t, mirrorImageScript(t, &createBody, imageID, `"mysql:8.4"`), &recordingPortOpener{})
	_, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: "mysql:8.4@sha256:" + strings.Repeat("e", 64), RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net", Port: 3306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	})
	if err == nil {
		t.Fatal("清单中不存在的摘要应被拒绝")
	}
	var rejected *AgentError
	if !errors.As(err, &rejected) || !rejected.NotDispatched {
		t.Fatalf("未知摘要应作为未派发预检拒绝：%+v", err)
	}
	if createBody != "" {
		t.Fatal("拒绝时不得发出创建请求")
	}
}

func TestCreateRestrictedResolvesMirrorPulledImageByLocalList(t *testing.T) {
	imageID := strings.Repeat("b", 64)
	var createBody string
	containerID := strings.Repeat("d", 64)
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/task-box/json":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, fmt.Sprintf(`[{"Id":"sha256:%s"}]`, imageID), true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, fmt.Sprintf(`{"Id":"sha256:%s","Size":1000,"Created":"2026-11-04T00:00:00Z","RepoTags":["task-tool:1"],"RepoDigests":["docker.1panel.live/library/task-tool@sha256:%s"],"Config":{}}`, imageID, strings.Repeat("a", 64)), true
		case call.Method == http.MethodPost && call.Path == "/containers/create":
			createBody = call.Body
			return http.StatusCreated, fmt.Sprintf(`{"Id":"%s","Warnings":[]}`, containerID), true
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			return http.StatusOK, `{"Id":"` + containerID + `","Name":"/task-box","Created":"2026-11-04T00:00:00Z","Image":"sha256:` + imageID + `","State":{"Status":"running"},"Config":{"User":"65532:65532","Labels":{"elysian.managed":"true","elysian.agent.template":"restricted-v1"}},"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true"]},"Mounts":[]}`, true
		case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	container, err := facade.CreateRestricted(context.Background(), AgentCreateInput{
		Name: "task-box", Image: "task-tool:1@sha256:" + strings.Repeat("a", 64), RequestID: strings.Repeat("r", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	if container.ID != containerID {
		t.Fatalf("容器 ID 不符：%+v", container)
	}
	if !strings.Contains(createBody, `"Image":"sha256:`+imageID+`"`) {
		t.Fatalf("创建体未用镜像 ID 钉死：%s", createBody)
	}
}

func TestAgentRejectedConvertsInvalidRequestOnly(t *testing.T) {
	err := agentRejected(shared.InvalidRequest("服务容器只使用本机已存在的固定摘要镜像"))
	rejected, ok := err.(*AgentError)
	if !ok || !rejected.NotDispatched || rejected.Code != "docker-operation-rejected" || rejected.Message != "服务容器只使用本机已存在的固定摘要镜像" {
		t.Fatalf("预检拒绝应转未派发业务错误：%+v", err)
	}
	raw := errors.New("创建服务持久卷失败")
	if agentRejected(raw) != raw {
		t.Fatal("执行中失败不得被转成预检拒绝")
	}
	if agentRejected(nil) != nil {
		t.Fatal("nil 应原样通过")
	}
}

// newServiceFacade 构造带凭据登记与端口开放桩的 AgentFacade。
func newServiceFacade(t *testing.T, script engineScript, opener *recordingPortOpener) *AgentFacade {
	t.Helper()
	return newServiceFacadeWithStore(t, script, filepath.Join(t.TempDir(), "agent-service-containers.json"), opener)
}

// newServiceFacadeWithStore 复用既有登记文件路径构造（失败重试共享凭据登记）。
func newServiceFacadeWithStore(t *testing.T, script engineScript, path string, opener *recordingPortOpener) *AgentFacade {
	t.Helper()
	service := newDockerService(serviceDeps{
		transport:       newFakeEngine(script),
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	return &AgentFacade{
		service:     service,
		authorize:   func(context.Context) error { return nil },
		credentials: newAgentCredentialStore(path),
		portOpener:  opener,
	}
}

type recordingPortOpener struct {
	calls []int
}

func (p *recordingPortOpener) EnsurePortRule(_ context.Context, port int, _ string) contract.FirewallPortSync {
	p.calls = append(p.calls, port)
	return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port}
}

// serviceContainerInspectBody 成功创建并启动后的容器 inspect 应答；
// 字段集满足 mapContainer（含顶层 Image 与 Mounts）。
func serviceContainerInspectBody() string {
	body := map[string]any{
		"Id": strings.Repeat("c", 64), "Name": "/mysql-main", "Created": "2026-11-04T00:00:00Z",
		"Image": agentServiceImage,
		"State": map[string]any{"Status": "running"},
		"Config": map[string]any{"Image": agentServiceImage, "Labels": map[string]string{
			labelManaged: labelTrueValue, "elysian.agent.template": agentServiceTemplate,
		}},
		"HostConfig": map[string]any{"NetworkMode": "elysian-agent-net", "ReadonlyRootfs": false},
		"Mounts":     []any{map[string]any{"Type": "volume", "Name": "elysian-agent-v1", "Destination": "/var/lib/mysql"}},
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

// scriptServiceCreate 覆盖一次 any-host 成功创建所需的全部 Engine 应答；
// 镜像核验走本机清单（RepoTags 含完整引用形态、RepoDigests 保留源站命名），
// 创建后的容器 inspect（start 回读与回执）统一走 serviceContainerInspectBody。
func scriptServiceCreate(call engineCall) (int, string, bool) {
	containerID := strings.Repeat("c", 64)
	imageID := strings.Repeat("b", 64)
	switch {
	case call.Method == http.MethodGet && call.Path == "/containers/mysql-main/json":
		return http.StatusNotFound, "", true
	case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
		return http.StatusOK, serviceContainerInspectBody(), true
	case call.Method == http.MethodGet && call.Path == "/images/json":
		return http.StatusOK, fmt.Sprintf(`[{"Id":"sha256:%s"}]`, imageID), true
	case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
		return http.StatusOK, fmt.Sprintf(`{"Id":"sha256:%s","Size":1103000000,"Created":"2026-11-04T00:00:00Z","RepoTags":["docker.io/library/mysql:8.4"],"RepoDigests":["docker.1panel.live/library/mysql@sha256:%s"],"Config":{}}`, imageID, agentServiceDigest), true
	case call.Method == http.MethodGet && call.Path == "/networks/elysian-agent-net":
		return http.StatusNotFound, "", true
	case call.Method == http.MethodPost && call.Path == "/networks/create":
		return http.StatusCreated, `{"Id":"net-1","Warning":""}`, true
	case call.Method == http.MethodPost && call.Path == "/volumes/create":
		return http.StatusCreated, `{"Name":"elysian-agent-v1"}`, true
	case call.Method == http.MethodPost && call.Path == "/containers/create":
		return http.StatusCreated, fmt.Sprintf(`{"Id":"%s","Warnings":[]}`, containerID), true
	case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
		return http.StatusNoContent, "", true
	default:
		return 0, "", false
	}
}

func TestCreateServiceAnyHostCreatesVolumeNetworkCredentialsAndOpensFirewall(t *testing.T) {
	opener := &recordingPortOpener{}
	facade := newServiceFacade(t, scriptServiceCreate, opener)
	result, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "any-host", Port: 3306, HostPort: 13306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	})
	if err != nil {
		t.Fatal(err)
	}
	container, _ := result["container"].(ContainerSummary)
	if container.ID != strings.Repeat("c", 64) {
		t.Fatalf("回执容器 ID 不符：%+v", container)
	}
	if names, _ := result["credentials"].([]string); len(names) != 1 || names[0] != "MYSQL_ROOT_PASSWORD" {
		t.Fatalf("回执只应报凭据变量名：%v", result["credentials"])
	}
	if result["networkScope"] != "any-host" || result["hostPort"] != 13306 {
		t.Fatalf("回执档位不符：%v %v", result["networkScope"], result["hostPort"])
	}
	record, err := facade.credentials.find("mysql-main")
	if err != nil || record == nil || len(record.Credentials["MYSQL_ROOT_PASSWORD"]) != 48 {
		t.Fatalf("凭据登记缺失：%+v %v", record, err)
	}
	if len(opener.calls) != 1 || opener.calls[0] != 13306 {
		t.Fatalf("any-host 应联动防火墙开口：%v", opener.calls)
	}
}

func TestCreateServiceRejectsBadInputs(t *testing.T) {
	facade := newServiceFacade(t, func(engineCall) (int, string, bool) { return 0, "", false }, &recordingPortOpener{})
	base := AgentServiceCreateInput{Name: "x", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net"}
	cases := map[string]func(*AgentServiceCreateInput){
		"镜像必须摘要":          func(in *AgentServiceCreateInput) { in.Image = "mysql:8.4" },
		"资源档枚举":           func(in *AgentServiceCreateInput) { in.ResourceTier = "huge" },
		"网络档枚举":           func(in *AgentServiceCreateInput) { in.NetworkScope = "public" },
		"宿主端口保留":          func(in *AgentServiceCreateInput) { in.NetworkScope = "any-host"; in.Port = 3306; in.HostPort = 48100 },
		"any-host 缺端口":    func(in *AgentServiceCreateInput) { in.NetworkScope = "any-host"; in.Port = 3306 },
		"localhost 缺容器端口": func(in *AgentServiceCreateInput) { in.NetworkScope = "localhost" },
		"凭据变量名格式":         func(in *AgentServiceCreateInput) { in.Credentials = []string{"mysql-password"} },
		"凭据变量去重上限": func(in *AgentServiceCreateInput) {
			in.Credentials = []string{"A_1", "A_2", "A_3", "A_4", "A_5", "A_6", "A_7", "A_8", "A_9"}
		},
		"env 格式": func(in *AgentServiceCreateInput) { in.Env = []string{"TZ"} },
		"卷绝对路径":  func(in *AgentServiceCreateInput) { in.Volumes = []string{"var/lib/mysql"} },
		"卷数量上限":  func(in *AgentServiceCreateInput) { in.Volumes = []string{"/a", "/b", "/c"} },
	}
	for name, mutate := range cases {
		input := base
		mutate(&input)
		if _, err := facade.CreateService(context.Background(), input); err == nil {
			t.Fatalf("%s：应被拒绝", name)
		}
	}
}

// serviceTargetInspectBody 按模板标签构造容器 inspect 应答；顶层含 Image 与
// Mounts，满足 safeTarget 核验与 mapContainer 回读。
func serviceTargetInspectBody(template string, digest string, readonlyRoot bool, mounts []any) string {
	body := map[string]any{
		"Id": strings.Repeat("c", 64), "Name": "/mysql-main", "Created": "2026-11-04T00:00:00Z",
		"Image": agentServiceImage,
		"State": map[string]any{"Status": "running"},
		"Config": map[string]any{"Image": agentServiceImage, "Labels": map[string]string{
			labelManaged: labelTrueValue, "elysian.agent.template": template,
			"elysian.agent.create-digest": digest,
		}},
		"HostConfig": map[string]any{"NetworkMode": "elysian-agent-net", "ReadonlyRootfs": readonlyRoot},
		"Mounts":     mounts,
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func TestCreateServiceAdoptReusesCredentialsWithoutRegeneration(t *testing.T) {
	opener := &recordingPortOpener{}
	created := newServiceFacade(t, scriptServiceCreate, opener)
	input := AgentServiceCreateInput{
		Name: "mysql-main", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net", Port: 3306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	}
	if _, err := created.CreateService(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	first, _ := created.credentials.find("mysql-main")
	// 第二次同参数请求：容器已存在（inspect 200，标签 digest 匹配），应 adopt 且凭据不变。
	digest := serviceCreateDigest(input)
	script := func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, serviceTargetInspectBody(agentServiceTemplate, digest, false, []any{
				map[string]any{"Type": "volume", "Name": "elysian-agent-v1", "Destination": "/var/lib/mysql"},
			}), true
		}
		return 0, "", false
	}
	retry := newServiceFacadeWithStore(t, script, created.credentials.path, &recordingPortOpener{})
	result, err := retry.CreateService(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if names, _ := result["credentials"].([]string); len(names) != 1 {
		t.Fatalf("adopt 回执应报凭据变量名：%v", result["credentials"])
	}
	second, _ := retry.credentials.find("mysql-main")
	if second.Credentials["MYSQL_ROOT_PASSWORD"] != first.Credentials["MYSQL_ROOT_PASSWORD"] {
		t.Fatal("adopt 不应重新生成凭据")
	}
}

// 启动失败必须回滚：先删已建容器、再删本次创建的卷，避免残留容器引用已删卷。
func TestCreateServiceStartFailureRemovesContainerAndVolumes(t *testing.T) {
	containerID := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		imageID := strings.Repeat("b", 64)
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/mysql-main/json":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			return http.StatusOK, serviceContainerInspectBody(), true
		case call.Method == http.MethodGet && call.Path == "/images/json":
			return http.StatusOK, fmt.Sprintf(`[{"Id":"sha256:%s"}]`, imageID), true
		case call.Method == http.MethodGet && call.Path == "/images/"+encodeEngineID("sha256:"+imageID)+"/json":
			return http.StatusOK, fmt.Sprintf(`{"Id":"sha256:%s","Size":1103000000,"Created":"2026-11-04T00:00:00Z","RepoTags":["docker.io/library/mysql:8.4"],"RepoDigests":["docker.1panel.live/library/mysql@sha256:%s"],"Config":{}}`, imageID, agentServiceDigest), true
		case call.Method == http.MethodGet && call.Path == "/networks/elysian-agent-net":
			return http.StatusNotFound, "", true
		case call.Method == http.MethodPost && call.Path == "/networks/create":
			return http.StatusCreated, `{"Id":"net-1","Warning":""}`, true
		case call.Method == http.MethodPost && call.Path == "/volumes/create":
			return http.StatusCreated, `{"Name":"elysian-agent-v1"}`, true
		case call.Method == http.MethodPost && call.Path == "/containers/create":
			return http.StatusCreated, fmt.Sprintf(`{"Id":"%s","Warnings":[]}`, containerID), true
		case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/start":
			return http.StatusInternalServerError, `{"message":"engine boom"}`, true
		case call.Method == http.MethodDelete:
			return http.StatusNoContent, "", true
		default:
			return 0, "", false
		}
	})
	service := newDockerService(serviceDeps{
		transport:       engine,
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	facade := &AgentFacade{
		service:     service,
		authorize:   func(context.Context) error { return nil },
		credentials: newAgentCredentialStore(filepath.Join(t.TempDir(), "agent-service-containers.json")),
		portOpener:  &recordingPortOpener{},
	}
	if _, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net", Port: 3306,
		Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Volumes: []string{"/var/lib/mysql"},
	}); err == nil {
		t.Fatal("启动失败应返回错误")
	}
	containerDeleteAt, volumeDeleteAt := -1, -1
	for i, call := range engine.Requests() {
		if call.Method == http.MethodDelete && call.Path == "/containers/"+containerID {
			containerDeleteAt = i
		}
		if call.Method == http.MethodDelete && call.Path == "/volumes/elysian-agent-0-req-1" {
			volumeDeleteAt = i
		}
	}
	if containerDeleteAt < 0 {
		t.Fatal("启动失败应回滚删除已建容器")
	}
	if volumeDeleteAt < 0 {
		t.Fatal("启动失败应回滚删除已建卷")
	}
	if containerDeleteAt > volumeDeleteAt {
		t.Fatal("回滚应先删容器再删卷")
	}
}

var agentSecret48Pattern = regexp.MustCompile(`^[0-9a-f]{48}$`)

// 既有登记只覆盖部分变量名时，缺失的逐名补生成；已有变量值保持不变。
func TestCreateServiceFillsMissingCredentialsPerName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-service-containers.json")
	store := newAgentCredentialStore(path)
	oldSecret := strings.Repeat("o", 48)
	if err := store.save(agentServiceCredentialRecord{Name: "mysql-main", Credentials: map[string]string{"OLD_VAR": oldSecret}}); err != nil {
		t.Fatal(err)
	}
	engine := newFakeEngine(scriptServiceCreate)
	service := newDockerService(serviceDeps{
		transport:       engine,
		mountRoot:       "/srv",
		reservedPorts:   []int{22, 48100, 48101},
		selfContainerID: strings.Repeat("f", 64),
	})
	facade := &AgentFacade{
		service:     service,
		authorize:   func(context.Context) error { return nil },
		credentials: store,
		portOpener:  &recordingPortOpener{},
	}
	if _, err := facade.CreateService(context.Background(), AgentServiceCreateInput{
		Name: "mysql-main", Image: agentServiceImage, RequestID: "req-1",
		ResourceTier: "medium", NetworkScope: "container-net", Port: 3306,
		Credentials: []string{"OLD_VAR", "NEW_VAR"}, Volumes: []string{"/var/lib/mysql"},
	}); err != nil {
		t.Fatal(err)
	}
	record, err := facade.credentials.find("mysql-main")
	if err != nil || record == nil {
		t.Fatalf("凭据登记缺失：%v %v", record, err)
	}
	if record.Credentials["OLD_VAR"] != oldSecret {
		t.Fatalf("既有变量值不应重新生成：%q", record.Credentials["OLD_VAR"])
	}
	if !agentSecret48Pattern.MatchString(record.Credentials["NEW_VAR"]) {
		t.Fatalf("新增变量应逐名补生成 48 位十六进制：%q", record.Credentials["NEW_VAR"])
	}
	var createBody struct {
		Env []string `json:"Env"`
	}
	found := false
	for _, call := range engine.Requests() {
		if call.Method == http.MethodPost && call.Path == "/containers/create" {
			if err := json.Unmarshal([]byte(call.Body), &createBody); err != nil {
				t.Fatalf("create 请求体解析失败：%v", err)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("未录到容器创建请求")
	}
	envValues := map[string]string{}
	for _, entry := range createBody.Env {
		key, value, _ := strings.Cut(entry, "=")
		envValues[key] = value
	}
	if envValues["OLD_VAR"] != oldSecret {
		t.Fatalf("Env 中既有变量值不符：%q", envValues["OLD_VAR"])
	}
	if !agentSecret48Pattern.MatchString(envValues["NEW_VAR"]) {
		t.Fatalf("Env 中新增变量值必须非空 48 位：%q", envValues["NEW_VAR"])
	}
}

// service-v1 容器可被 start/stop/restart/remove 操作；restricted-v1 核验保持不变。
func TestSafeTargetAcceptsServiceTemplateAndKeepsRestrictedChecks(t *testing.T) {
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasPrefix(call.Path, "/containers/") && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, serviceTargetInspectBody(agentServiceTemplate, "digest-1", false, []any{
				map[string]any{"Type": "volume", "Name": agentVolumePrefix + "v1", "Destination": "/var/lib/mysql"},
			}), true
		}
		if call.Method == http.MethodPost && strings.HasSuffix(call.Path, "/stop") {
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	if _, err := facade.Action(context.Background(), strings.Repeat("c", 64), "stop"); err != nil {
		t.Fatalf("service-v1 容器应可停止：%v", err)
	}
}

// service-v1 挂载非 elysian-agent- 卷（宿主绑定）必须拒绝。
func TestSafeTargetRejectsForeignMounts(t *testing.T) {
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, serviceTargetInspectBody(agentServiceTemplate, "digest-1", false, []any{
				map[string]any{"Type": "bind", "Source": "/srv/www", "Destination": "/var/www"},
			}), true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	if _, err := facade.Action(context.Background(), strings.Repeat("c", 64), "stop"); err == nil {
		t.Fatal("宿主绑定挂载的容器不得被 Agent 操作")
	}
}

// restricted-v1 容器（无网络、只读根）继续通过既有核验路径操作。
func TestSafeTargetKeepsRestrictedPath(t *testing.T) {
	script := func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && strings.HasSuffix(call.Path, "/json") {
			return http.StatusOK, `{"Id":"` + strings.Repeat("c", 64) + `","Name":"/task-box","Created":"2026-11-04T00:00:00Z","Image":"task-image@sha256:` + strings.Repeat("a", 64) + `","State":{"Status":"running"},"Config":{"User":"65532:65532","Labels":{"` + labelManaged + `":"true","elysian.agent.template":"restricted-v1"}},"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true"]},"Mounts":[]}`, true
		}
		if call.Method == http.MethodPost && strings.HasSuffix(call.Path, "/stop") {
			return http.StatusNoContent, "", true
		}
		return 0, "", false
	}
	facade := newServiceFacade(t, script, &recordingPortOpener{})
	if _, err := facade.Action(context.Background(), strings.Repeat("c", 64), "stop"); err != nil {
		t.Fatalf("restricted-v1 核验不应被破坏：%v", err)
	}
}
