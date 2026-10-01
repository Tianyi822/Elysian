package docker

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

// createSpec 对等测试（createSpec.test.ts 锚点）。

func validCreateBody() string {
	return `{"imageId":"` + strings.Repeat("a", 64) + `"}`
}

func specInput(body string) buildCreateSpecInput {
	value, err := decodeOrderedJSON([]byte(body))
	if err != nil {
		panic(err)
	}
	return buildCreateSpecInput{
		body:          value,
		images:        []imageBrief{{id: strings.Repeat("a", 64), name: "nginx"}},
		containers:    nil,
		mountRoot:     "/srv",
		reservedPorts: []int{22, 48100, 48101},
		realpath:      func(string) (string, error) { return "", errors.New("不应解析路径") },
	}
}

func wantInvalid(t *testing.T, body string, status int, message string) {
	t.Helper()
	_, err := buildCreateSpec(specInput(body))
	if err == nil {
		t.Fatalf("应拒绝：%s", body)
	}
	if status == 400 {
		invalid, ok := err.(*shared.InvalidRequestError)
		if !ok || invalid.Status != 400 || invalid.Message != message {
			t.Fatalf("got %#v，want 400 %q", err, message)
		}
	} else {
		invalid, ok := err.(*shared.InvalidRequestError)
		if !ok || invalid.Status != status || invalid.Message != message {
			t.Fatalf("got %#v，want %d %q", err, status, message)
		}
	}
}

func TestCreateSpecUnknownImage(t *testing.T) {
	wantInvalid(t, `{"imageId":"`+strings.Repeat("b", 64)+`"}`, 400, "镜像不存在，无法创建容器")
}

func TestCreateSpecImageIdInvalid(t *testing.T) {
	wantInvalid(t, `{"imageId":"not-hex"}`, 400, "镜像 ID 无效")
	wantInvalid(t, `{"imageId":""}`, 400, "请选择镜像")
	wantInvalid(t, `{"imageId":123}`, 400, "请选择镜像")
	wantInvalid(t, `[]`, 400, "请求体无效")
}

func TestCreateSpecNameConflicts(t *testing.T) {
	input := specInput(`{"imageId":"` + strings.Repeat("a", 64) + `","name":"web-1"}`)
	input.containers = []containerBrief{{name: "web-1"}}
	_, err := buildCreateSpec(input)
	invalid, ok := err.(*shared.InvalidRequestError)
	if !ok || invalid.Status != 409 || invalid.Message != "容器名称已存在：web-1" {
		t.Fatalf("重名 409：%#v", err)
	}

	input = specInput(`{"name":"坏 名字","imageId":"` + strings.Repeat("a", 64) + `"}`)
	_, err = buildCreateSpec(input)
	invalid, ok = err.(*shared.InvalidRequestError)
	if !ok || invalid.Status != 400 || invalid.Message != "名称须以字母或数字开头，仅含字母、数字、下划线、点与连字符" {
		t.Fatalf("名称非法 400：%#v", err)
	}

	input = specInput(`{"name":123,"imageId":"` + strings.Repeat("a", 64) + `"}`)
	_, err = buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "名称无效" {
		t.Fatalf("名称非字符串：%#v", err)
	}
}

func TestCreateSpecAutoName(t *testing.T) {
	input := specInput(validCreateBody())
	input.images = []imageBrief{{id: strings.Repeat("a", 64), name: "library/redis"}}
	input.containers = []containerBrief{{name: "library-redis"}}
	spec, err := buildCreateSpec(input)
	if err != nil {
		t.Fatal(err)
	}
	if spec.name != "library-redis-2" {
		t.Fatalf("自动命名 / → - 冲突追加 -2：%q", spec.name)
	}
}

func TestCreateSpecPortsValidation(t *testing.T) {
	var rows []string
	for i := 0; i < 33; i++ {
		rows = append(rows, `{"containerPort":80,"hostPort":`+itoa(10000+i)+`}`)
	}
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[`+strings.Join(rows, ",")+`]}`, 400, "端口映射不能超过 32 条")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[{"containerPort":0,"hostPort":100}]}`, 400, "容器端口须为 1-65535 的整数")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[{"containerPort":80,"hostPort":70000}]}`, 400, "宿主端口须为 1-65535 的整数")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[{"containerPort":80,"hostPort":100,"protocol":"sctp"}]}`, 400, "端口协议无效")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[{"containerPort":80,"hostPort":100,"hostIp":"10.0.0.1"}]}`, 400, "hostIp 只允许 127.0.0.1 或 0.0.0.0")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":[{"containerPort":80,"hostPort":22}]}`, 400, "宿主端口为面板保留：22")
	wantInvalid(t, `{"imageId":"`+strings.Repeat("a", 64)+`","ports":"x"}`, 400, "ports 须为数组")
}

func TestCreateSpecPortConflicts(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	// 现有容器占用。
	input := specInput(base + `,"ports":[{"containerPort":80,"hostPort":8080}]}`)
	input.containers = []containerBrief{{name: "x", ports: []portBrief{{hostPort: 8080, protocol: "tcp", hostIP: "127.0.0.1"}}}}
	_, err := buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "宿主端口已被占用：8080/tcp" {
		t.Fatalf("与现有容器冲突：%#v", err)
	}
	// 0.0.0.0 与 127.0.0.1 同端口重叠。
	input = specInput(base + `,"ports":[{"containerPort":80,"hostPort":8081,"hostIp":"127.0.0.1"},{"containerPort":81,"hostPort":8081,"hostIp":"0.0.0.0"}]}`)
	_, err = buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "宿主端口已被占用：8081/tcp" {
		t.Fatalf("本请求内重叠：%#v", err)
	}
	// udp 与 tcp 不冲突。
	input = specInput(base + `,"ports":[{"containerPort":80,"hostPort":8082,"protocol":"udp"},{"containerPort":81,"hostPort":8082}]}`)
	if _, err := buildCreateSpec(input); err != nil {
		t.Fatalf("udp/tcp 不冲突：%v", err)
	}
}

func TestCreateSpecEnvValidation(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	var rows []string
	for i := 0; i < 65; i++ {
		rows = append(rows, `{"key":"K`+itoa(i)+`","value":"v"}`)
	}
	wantInvalid(t, base+`,"env":[`+strings.Join(rows, ",")+`]}`, 400, "环境变量不能超过 64 个")
	wantInvalid(t, base+`,"env":[{"key":"1BAD","value":"v"}]}`, 400, "环境变量名无效")
	wantInvalid(t, base+`,"env":[{"key":"A","value":"v"},{"key":"A","value":"w"}]}`, 400, "环境变量名重复")
	wantInvalid(t, base+`,"env":[{"key":"A","value":"`+strings.Repeat("x", 4097)+`"}]}`, 400, "环境变量值过长")
	wantInvalid(t, base+`,"env":[{"key":"A","value":"a\nb"}]}`, 400, "环境变量值不能包含换行或控制字符")
}

func TestCreateSpecVolumesValidation(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	wantInvalid(t, base+`,"volumes":[{"hostPath":"etc","containerPath":"/etc"}]}`, 400, "无效的宿主机挂载路径：etc")
	wantInvalid(t, base+`,"volumes":[{"hostPath":"/etc","containerPath":"/etc"}]}`, 400, "绑定挂载路径须位于 /srv 之下")
	wantInvalid(t, base+`,"volumes":[{"hostPath":"/srv","containerPath":"/data"}]}`, 400, "不能将挂载根目录挂载进容器")
	wantInvalid(t, base+`,"volumes":[{"hostPath":"/srv/a","containerPath":"/"}]}`, 400, "容器内挂载路径不能为根目录")
	wantInvalid(t, base+`,"volumes":[{"hostPath":"/srv/a","containerPath":"/a"},{"hostPath":"/srv/b","containerPath":"/a"}]}`, 400, "容器内挂载路径重复")
	var rows []string
	for i := 0; i < 17; i++ {
		rows = append(rows, `{"hostPath":"/srv/p`+itoa(i)+`","containerPath":"/p`+itoa(i)+`"}`)
	}
	wantInvalid(t, base+`,"volumes":[`+strings.Join(rows, ",")+`]}`, 400, "挂载不能超过 16 个")
}

func TestCreateSpecVolumesRealpath(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	// realpath 解析逃逸。
	input := specInput(base + `,"volumes":[{"hostPath":"/srv/app","containerPath":"/app"}]}`)
	input.realpath = func(string) (string, error) { return "/etc", nil }
	_, err := buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "挂载路径超出允许范围" {
		t.Fatalf("逃逸拒绝：%#v", err)
	}
	// realpath 抛 InvalidRequestError 原样透传（符号链接拒绝）。
	input.realpath = func(string) (string, error) {
		return "", shared.InvalidRequest("挂载路径经过符号链接，已拒绝")
	}
	_, err = buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "挂载路径经过符号链接，已拒绝" {
		t.Fatalf("透传：%#v", err)
	}
}

func TestCreateSpecVolumesMkdirPaths(t *testing.T) {
	dir := t.TempDir()
	input := specInput(`{"imageId":"` + strings.Repeat("a", 64) + `","volumes":[{"hostPath":"` + dir + `/a/b/c","containerPath":"/c"}]}`)
	input.mountRoot = dir
	input.realpath = defaultRealpath
	spec, err := buildCreateSpec(input)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(dir, "a"), filepath.Join(dir, "a", "b"), filepath.Join(dir, "a", "b", "c")}
	if len(spec.mkdirPaths) != len(want) {
		t.Fatalf("逐级 mkdir：%v", spec.mkdirPaths)
	}
	for i := range want {
		if spec.mkdirPaths[i] != want[i] {
			t.Fatalf("第 %d 级 %q，want %q", i, spec.mkdirPaths[i], want[i])
		}
	}
}

func TestCreateSpecCommand(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	wantInvalid(t, base+`,"command":"echo 'unterminated"}`, 400, "启动命令含有未闭合的引号")
	wantInvalid(t, base+`,"command":"echo\nhi"}`, 400, "启动命令不能包含换行")
	var words []string
	for i := 0; i < 257; i++ {
		words = append(words, "w"+itoa(i))
	}
	wantInvalid(t, base+`,"command":"`+strings.Join(words, " ")+`"}`, 400, "启动命令参数不能超过 256 个")
	wantInvalid(t, base+`,"restartPolicy":"always-restart"}`, 400, "重启策略无效")
}

func TestCreateSpecValidBodyWhitelist(t *testing.T) {
	input := specInput(`{
		"imageId":"sha256:` + strings.Repeat("a", 64) + `",
		"name":"web-1",
		"ports":[{"containerPort":80,"hostPort":8080,"protocol":"tcp","hostIp":"127.0.0.1"}],
		"env":[{"key":"MODE","value":"prod"},{"key":"EMPTY","value":null}],
		"command":"nginx -g 'daemon off;'",
		"restartPolicy":"on-failure"
	}`)
	input.containers = []containerBrief{{name: "other"}}
	spec, err := buildCreateSpec(input)
	if err != nil {
		t.Fatal(err)
	}
	if spec.name != "web-1" {
		t.Fatalf("name：%q", spec.name)
	}
	got := string(spec.createBody)
	for _, want := range []string{
		`"Image":"` + strings.Repeat("a", 64) + `"`,
		`"Labels":{"elysian.managed":"true"}`,
		`"RestartPolicy":{"Name":"on-failure","MaximumRetryCount":0}`,
		`"PortBindings":{"80/tcp":[{"HostPort":"8080","HostIp":"127.0.0.1"}]}`,
		`"Cmd":["nginx","-g","daemon off;"]`,
		`"Env":["MODE=prod","EMPTY="]`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("create 体缺 %q：%s", want, got)
		}
	}
	for _, banned := range []string{"Privileged", "Binds", "NetworkMode", `"Mounts"`} {
		if strings.Contains(got, banned) {
			t.Fatalf("create 体不得含 %q：%s", banned, got)
		}
	}
}

func TestCreateSpecDefaultRestartPolicy(t *testing.T) {
	spec, err := buildCreateSpec(specInput(validCreateBody()))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(spec.createBody), `"RestartPolicy":{"Name":"no"}`) {
		t.Fatalf("缺省 no：%s", spec.createBody)
	}
	if spec.name != "nginx" {
		t.Fatalf("缺省名取镜像名：%q", spec.name)
	}
}

// 真实文件系统上的挂载路径行为（/etc 拒绝、符号链接拒绝）。
func TestCreateSpecRealFilesystem(t *testing.T) {
	base := `{"imageId":"` + strings.Repeat("a", 64) + `"`
	input := specInput(base + `,"volumes":[{"hostPath":"/srv/../etc","containerPath":"/etc"}]}`)
	input.realpath = defaultRealpath
	_, err := buildCreateSpec(input)
	if invalid, ok := err.(*shared.InvalidRequestError); !ok || invalid.Message != "无效的宿主机挂载路径：/srv/../etc" {
		t.Fatalf(".. 段拒绝：%#v", err)
	}

	dir := t.TempDir()
	link := filepath.Join(dir, "link")
	target := filepath.Join(dir, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	input = specInput(`{"imageId":"` + strings.Repeat("a", 64) + `","volumes":[{"hostPath":"` + link + `","containerPath":"/l"}]}`)
	input.mountRoot = "/tmp"
	input.realpath = defaultRealpath
	spec, err := buildCreateSpec(input)
	if err != nil {
		t.Fatal(err)
	}
	if spec.mkdirPaths != nil && len(spec.mkdirPaths) > 0 {
		t.Fatalf("已存在路径不应产出 mkdir：%v", spec.mkdirPaths)
	}
}
