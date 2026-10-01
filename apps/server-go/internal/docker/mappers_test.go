package docker

import (
	"testing"
)

// mappers 对等测试（dockerMappers.test.ts 锚点）。

func baseContainerInspectJSON() string {
	return `{
		"Id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"Name": "/web-1",
		"Created": "2024-05-01T08:00:00.000000000Z",
		"State": {"Status": "running", "StartedAt": "2024-05-02T08:00:00.000000000Z"},
		"Config": {"Image": "nginx:1.27", "Env": ["PATH=/usr/bin", "FOO=bar"]},
		"HostConfig": {"PortBindings": {}, "RestartPolicy": {"Name": "no"}},
		"Path": "nginx",
		"Args": ["-g", "daemon off;"],
		"Mounts": [],
		"Image": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	}`
}

func mustDecode(t *testing.T, raw string) any {
	t.Helper()
	value, err := decodeOrderedJSON([]byte(raw))
	if err != nil {
		t.Fatalf("decodeOrderedJSON 失败：%v", err)
	}
	return value
}

func TestMapContainerStatusMapping(t *testing.T) {
	cases := map[string]string{
		"running":    "running",
		"restarting": "restarting",
		"paused":     "paused",
		"exited":     "stopped",
		"dead":       "stopped",
		"created":    "stopped",
		"removing":   "stopped",
	}
	for engine, want := range cases {
		raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"` + engine + `"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"img"}`
		container, err := mapContainer(mustDecode(t, raw))
		if err != nil {
			t.Fatalf("%s：%v", engine, err)
		}
		if container.Status != want {
			t.Fatalf("%s → %s，want %s", engine, container.Status, want)
		}
	}
}

func TestMapContainerStoppedDropsStartedAt(t *testing.T) {
	raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"exited","StartedAt":"2024-05-02T08:00:00Z"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"img"}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	if container.StartedAt != "" {
		t.Fatalf("stopped 应丢弃 startedAt，got %q", container.StartedAt)
	}
	if container.ImageRef != "" {
		t.Fatalf("无 Config.Image 应省略 imageRef")
	}
}

func TestMapContainerZeroStartedAtDropped(t *testing.T) {
	raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"running","StartedAt":"0001-01-01T00:00:00Z"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"img"}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	if container.StartedAt != "" {
		t.Fatalf("零时间 startedAt 应丢弃")
	}
}

func TestMapContainerInvalidShape(t *testing.T) {
	cases := []struct {
		raw     string
		message string
	}{
		{`[]`, "容器详情格式无效：根对象必须是对象"},
		{`{"Name":"/n"}`, "容器详情格式无效：缺少 Id"},
		{`{"Id":"i"}`, "容器详情格式无效：缺少 Name"},
		{`{"Id":"i","Name":"/n","Created":"c"}`, "容器详情格式无效：缺少 State"},
		{`{"Id":"i","Name":"/n","Created":"c","State":{}}`, "容器详情格式无效：缺少 State.Status"},
		{`{"Id":"i","Name":"/n","State":{"Status":"running"},"Config":{}}`, "容器详情格式无效：缺少 Created"},
		{`{"Id":"i","Name":"/n","Created":"c","State":{"Status":"running"}}`, "容器详情格式无效：缺少 Config"},
		{`{"Id":"i","Name":"/n","Created":"c","State":{"Status":"running"},"Config":{},"HostConfig":{},"Mounts":[]}`, "容器详情格式无效：缺少 Image"},
	}
	for _, tc := range cases {
		_, err := mapContainer(mustDecode(t, tc.raw))
		if err == nil || err.Error() != tc.message {
			t.Fatalf("got %v，want %q", err, tc.message)
		}
	}
}

func TestMapContainerPortBindings(t *testing.T) {
	raw := `{
		"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},
		"Config":{},"Mounts":[],"Image":"img",
		"HostConfig":{"PortBindings":{
			"80/tcp":[{"HostPort":"8080","HostIp":"0.0.0.0"},{"HostPort":"8080","HostIp":"::"}],
			"53/udp":[{"HostPort":"","HostIp":"0.0.0.0"},{"HostPort":"5353","HostIp":""}],
			"9090/tcp":[{"HostPort":"9090"}]
		}}
	}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(container.Ports) != 3 {
		t.Fatalf("端口数 %d，want 3：%+v", len(container.Ports), container.Ports)
	}
	first := container.Ports[0]
	if first.ContainerPort != 80 || first.HostPort != 8080 || first.Protocol != "tcp" || first.HostIP != "0.0.0.0" {
		t.Fatalf("0.0.0.0 与 :: 应合并：%+v", first)
	}
	second := container.Ports[1]
	if second.HostPort != 5353 || second.HostIP != "" {
		t.Fatalf("空 HostPort 跳过、空 hostIp 省略：%+v", second)
	}
	third := container.Ports[2]
	if third.HostPort != 9090 || third.HostIP != "" {
		t.Fatalf("缺省 HostIp 视为空串省略：%+v", third)
	}
}

func TestMapContainerPortOrderFollowsEngineKeyOrder(t *testing.T) {
	rawA := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},"Config":{},"Mounts":[],"Image":"img","HostConfig":{"PortBindings":{"90/tcp":[{"HostPort":"9090"}],"10/tcp":[{"HostPort":"1010"}]}}}`
	rawB := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},"Config":{},"Mounts":[],"Image":"img","HostConfig":{"PortBindings":{"10/tcp":[{"HostPort":"1010"}],"90/tcp":[{"HostPort":"9090"}]}}}`
	a, err := mapContainer(mustDecode(t, rawA))
	if err != nil {
		t.Fatal(err)
	}
	b, err := mapContainer(mustDecode(t, rawB))
	if err != nil {
		t.Fatal(err)
	}
	if a.Ports[0].ContainerPort != 90 || b.Ports[0].ContainerPort != 10 {
		t.Fatalf("端口顺序应跟随 Engine 键序：a=%d b=%d", a.Ports[0].ContainerPort, b.Ports[0].ContainerPort)
	}
}

func TestMapContainerEnvMasking(t *testing.T) {
	raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},"Config":{"Env":["PATH=/bin","DB_PASSWORD=s3cret","API_TOKEN=t","SECRET=x","my_key=v","OK=1"]},"HostConfig":{},"Mounts":[],"Image":"img"}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	for _, pair := range container.Env {
		if pair.Key == "OK" || pair.Key == "PATH" {
			if pair.Value == nil || *pair.Value == "" {
				t.Fatalf("%s 不应打码", pair.Key)
			}
			continue
		}
		if pair.Value != nil {
			t.Fatalf("%s 应打码为 null", pair.Key)
		}
	}
}

func TestMapContainerMounts(t *testing.T) {
	raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},"Config":{},"HostConfig":{},"Image":"img",
		"Mounts":[
			{"Type":"bind","Source":"/srv/app","Destination":"/app"},
			{"Type":"volume","Name":"data","Destination":"/data"},
			{"Type":"tmpfs","Destination":"/tmp"}
		]}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(container.Volumes) != 3 {
		t.Fatalf("挂载数 %d", len(container.Volumes))
	}
	bind, volume, tmpfs := container.Volumes[0], container.Volumes[1], container.Volumes[2]
	if bind.Kind != "bind" || bind.HostPath != "/srv/app" || bind.ContainerPath != "/app" {
		t.Fatalf("bind：%+v", bind)
	}
	if volume.Kind != "volume" || volume.HostPath != "data" {
		t.Fatalf("volume：%+v", volume)
	}
	if tmpfs.Kind != "tmpfs" || tmpfs.HostPath != "" {
		t.Fatalf("tmpfs：%+v", tmpfs)
	}
}

func TestMapContainerCommandQuoting(t *testing.T) {
	raw := `{"Id":"i","Name":"/n","Created":"c","State":{"Status":"stopped"},"Config":{},"HostConfig":{},"Mounts":[],"Image":"img","Path":"sh","Args":["-c","echo 'hi'","plain"]}`
	container, err := mapContainer(mustDecode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	want := `sh -c 'echo '\''hi'\''' plain`
	if container.Command != want {
		t.Fatalf("command %q，want %q", container.Command, want)
	}
}

func TestMapContainerIdNameNormalize(t *testing.T) {
	container, err := mapContainer(mustDecode(t, baseContainerInspectJSON()))
	if err != nil {
		t.Fatal(err)
	}
	if container.ID != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("id 应去 sha256: 前缀：%s", container.ID)
	}
	if container.Name != "web-1" {
		t.Fatalf("name 应去前导 /：%s", container.Name)
	}
	if container.ImageRef != "nginx:1.27" {
		t.Fatalf("imageRef：%s", container.ImageRef)
	}
}

func TestMapImageRepoTagsSortedWithOtherTags(t *testing.T) {
	summary := mustDecode(t, `{"Id":"sha256:cccc"}`)
	inspect := mustDecode(t, `{"Id":"sha256:cccc","Size":1500000,"Created":"2024-05-01T08:00:00.000000000Z","RepoTags":["redis:9","nginx:1.27","nginx:latest"],"RepoDigests":["nginx@sha256:d"]}`)
	image, err := mapImage(summary, inspect)
	if err != nil {
		t.Fatal(err)
	}
	if image.Name != "nginx" || image.Tag != "1.27" {
		t.Fatalf("首个 RepoTag：%s:%s", image.Name, image.Tag)
	}
	if len(image.OtherTags) != 2 || image.OtherTags[0] != "nginx:latest" || image.OtherTags[1] != "redis:9" {
		t.Fatalf("otherTags：%v", image.OtherTags)
	}
	if image.Digest != "nginx@sha256:d" {
		t.Fatalf("digest：%s", image.Digest)
	}
	if image.SizeMB != 2 {
		t.Fatalf("sizeMb 四舍五入：%d", image.SizeMB)
	}
	if image.PulledAt == nil || *image.PulledAt != "2024-05-01T08:00:00.000000000Z" {
		t.Fatalf("pulledAt：%v", image.PulledAt)
	}
}

func TestMapImageNoRepoTags(t *testing.T) {
	summary := mustDecode(t, `{"Id":"sha256:dddd"}`)
	inspect := mustDecode(t, `{"Id":"sha256:dddd","Size":500000,"Created":"0001-01-01T00:00:00Z"}`)
	image, err := mapImage(summary, inspect)
	if err != nil {
		t.Fatal(err)
	}
	if image.Name != "<none>" || image.Tag != "<none>" {
		t.Fatalf("无 RepoTags → <none>：%s:%s", image.Name, image.Tag)
	}
	if image.PulledAt != nil {
		t.Fatalf("零时间 pulledAt → null")
	}
	if image.Digest != "sha256:dddd" {
		t.Fatalf("digest 回落 sha256:<id 前 12 位>：%s", image.Digest)
	}
}

func TestMapImageDigestShortIdFallback(t *testing.T) {
	id64 := "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff01"
	summary := mustDecode(t, `{"Id":"sha256:`+id64+`"}`)
	inspect := mustDecode(t, `{"Id":"sha256:`+id64+`","Size":1,"Created":"2024-05-01T08:00:00Z","RepoTags":["x:1"]}`)
	image, err := mapImage(summary, inspect)
	if err != nil {
		t.Fatal(err)
	}
	if image.Digest != "sha256:ffffffffffff" {
		t.Fatalf("digest：%s", image.Digest)
	}
}

func TestMapImageInvalidShape(t *testing.T) {
	cases := []struct {
		summary, inspect, message string
	}{
		{`[]`, `{}`, "镜像详情格式无效：摘要必须是对象"},
		{`{}`, `[]`, "镜像详情格式无效：详情必须是对象"},
		{`{}`, `{"Size":1}`, "镜像详情格式无效：缺少 Id"},
		{`{"Id":"a"}`, `{"Id":"a"}`, "镜像详情格式无效：Size 无效"},
		{`{"Id":"a"}`, `{"Id":"a","Size":1,"RepoTags":"x"}`, "镜像详情格式无效：RepoTags 必须是数组"},
	}
	for _, tc := range cases {
		_, err := mapImage(mustDecode(t, tc.summary), mustDecode(t, tc.inspect))
		if err == nil || err.Error() != tc.message {
			t.Fatalf("got %v，want %q", err, tc.message)
		}
	}
}
