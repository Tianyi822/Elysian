package websites

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// Engine 操作层（websitesDocker.test.ts 3 例 + 帧头剥离的 Go 对等）。

// fakeTransport 记录请求并按路径回放响应。
type fakeTransport struct {
	calls    []seam.EngineRequest
	response func(req seam.EngineRequest) seam.EngineResponse
	err      error
}

func (t *fakeTransport) Request(_ context.Context, req seam.EngineRequest) (seam.EngineResponse, error) {
	t.calls = append(t.calls, req)
	if t.err != nil {
		return seam.EngineResponse{}, t.err
	}
	return t.response(req), nil
}

func (t *fakeTransport) Stream(ctx context.Context, req seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	t.calls = append(t.calls, req)
	if t.err != nil {
		return seam.EngineResponse{}, t.err
	}
	return t.response(req), nil
}

const testContainerID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const testSiteContainerName = "elysian-site-0123456789ab"

func newFakeTransport() *fakeTransport {
	return &fakeTransport{response: func(req seam.EngineRequest) seam.EngineResponse {
		if strings.Contains(req.Path, "/containers/create") {
			return seam.EngineResponse{Status: 201, Body: []byte(`{"Id":"` + testContainerID + `"}`)}
		}
		if strings.HasSuffix(req.Path, "/json") {
			inspect := map[string]any{
				"Id":   testContainerID,
				"Name": "/" + testSiteContainerName,
				"Config": map[string]any{
					"Image": WEBSITE_HTML_IMAGE,
					"Labels": map[string]any{
						"elysian.managed":         "true",
						"elysian.website":         "true",
						"elysian.website.project": "p",
						"elysian.website.kind":    "html",
						"elysian.website.version": "html",
					},
				},
				"Mounts": []any{map[string]any{"Type": "bind", "Source": "/srv/wwwroot/site", "Destination": siteHTMLTarget}},
				"State":  map[string]any{"Running": false},
			}
			data, _ := marshalJSONCompact(inspect)
			return seam.EngineResponse{Status: 200, Body: data}
		}
		return seam.EngineResponse{Status: 204, Body: nil}
	}}
}

func newTestDocker(transport seam.DockerTransport) dockerOps {
	return NewWebsiteDocker(transport, func(context.Context) ([]contract.ContainerImage, error) { return nil, nil })
}

func TestDockerCreateDirectBinds(t *testing.T) {
	transport := newFakeTransport()
	docker := newTestDocker(transport)
	id, err := docker.Create(context.Background(), containerCreateInput{
		ImageRef: "node:24.21.0", Kind: KindNode, Version: "24.21.0", ProjectID: "p", Port: 3000,
		BindSource: "/srv/wwwroot/site", ContainerName: testSiteContainerName, AccessMode: AccessModeDirect,
		Command: stringPtr("node dist/main.js"),
	})
	if err != nil {
		t.Fatalf("创建应成功：%v", err)
	}
	if id != testContainerID {
		t.Fatalf("应返回引擎 Id")
	}
	var body struct {
		Cmd        []string `json:"Cmd"`
		HostConfig struct {
			Binds        []string `json:"Binds"`
			PortBindings map[string][]struct {
				HostIp   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"PortBindings"`
		} `json:"HostConfig"`
	}
	if err := json.Unmarshal(transport.calls[0].Body, &body); err != nil {
		t.Fatalf("创建体应为 JSON：%v", err)
	}
	binding := body.HostConfig.PortBindings["3000/tcp"]
	if len(binding) != 1 || binding[0].HostIp != "0.0.0.0" || binding[0].HostPort != "3000" {
		t.Fatalf("直连应绑 0.0.0.0:3000，得到 %+v", binding)
	}
	if len(body.Cmd) != 2 || body.Cmd[0] != "node" || body.Cmd[1] != "dist/main.js" {
		t.Fatalf("Cmd 应为 argv 数组，得到 %v", body.Cmd)
	}
	if len(body.HostConfig.Binds) != 1 || body.HostConfig.Binds[0] != "/srv/wwwroot/site:/app" {
		t.Fatalf("Node bind 应为 /srv/wwwroot/site:/app，得到 %v", body.HostConfig.Binds)
	}
}

func TestDockerCreateDomainHTML(t *testing.T) {
	transport := newFakeTransport()
	docker := newTestDocker(transport)
	_, err := docker.Create(context.Background(), containerCreateInput{
		ImageRef: WEBSITE_HTML_IMAGE, Kind: KindHTML, Version: "html", ProjectID: "p", Port: 8088,
		BindSource: "/srv/wwwroot/site", ContainerName: testSiteContainerName, AccessMode: AccessModeDomain,
		Command: nil,
	})
	if err != nil {
		t.Fatalf("创建应成功：%v", err)
	}
	var body struct {
		Cmd        []string `json:"Cmd"`
		HostConfig struct {
			Binds        []string `json:"Binds"`
			PortBindings map[string][]struct {
				HostIp   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"PortBindings"`
		} `json:"HostConfig"`
	}
	if err := json.Unmarshal(transport.calls[0].Body, &body); err != nil {
		t.Fatalf("创建体应为 JSON：%v", err)
	}
	binding := body.HostConfig.PortBindings["80/tcp"]
	if len(binding) != 1 || binding[0].HostIp != "127.0.0.1" || binding[0].HostPort != "8088" {
		t.Fatalf("域名模式应回环绑 127.0.0.1，宿主端口 8088，得到 %+v", binding)
	}
	if len(body.HostConfig.Binds) != 1 || body.HostConfig.Binds[0] != "/srv/wwwroot/site:/usr/share/nginx/html:ro" {
		t.Fatalf("HTML 应只读挂载站点目录，得到 %v", body.HostConfig.Binds)
	}
	if len(body.Cmd) != 3 || body.Cmd[0] != "nginx" || body.Cmd[2] != "daemon off;" {
		t.Fatalf("HTML 应用固定 Nginx 命令，得到 %v", body.Cmd)
	}
	result, err := docker.RemoveManaged(context.Background(), containerIdentity{
		ContainerID: testContainerID, ContainerName: testSiteContainerName, ProjectID: "p",
		Kind: KindHTML, Version: "html", ImageRef: WEBSITE_HTML_IMAGE, RootDir: "/srv/wwwroot/site",
	})
	if err != nil || result != "removed" {
		t.Fatalf("五重核对应通过并删除，得到 %s %v", result, err)
	}
}

func TestWebsiteContainerCmdParsing(t *testing.T) {
	args, err := WebsiteContainerCmd(KindJava, stringPtr(`java -jar "my app.jar"`))
	if err != nil {
		t.Fatalf("切词应成功：%v", err)
	}
	if len(args) != 3 || args[0] != "java" || args[1] != "-jar" || args[2] != "my app.jar" {
		t.Fatalf("双引号含空格应保词，得到 %v", args)
	}
	args, err = WebsiteContainerCmd(KindGo, stringPtr("./server --addr 0.0.0.0:8080"))
	if err != nil {
		t.Fatalf("切词应成功：%v", err)
	}
	if len(args) != 3 || args[0] != "./server" || args[1] != "--addr" || args[2] != "0.0.0.0:8080" {
		t.Fatalf("多参数应切词，得到 %v", args)
	}
	if _, err := WebsiteContainerCmd(KindGo, stringPtr("./server '未闭合")); err == nil || err.Error() != "启动命令的引号或转义不完整" {
		t.Fatalf("未闭合引号应报错，得到 %v", err)
	}
	if _, err := WebsiteContainerCmd(KindGo, nil); err == nil || err.Error() != "请填写容器启动命令" {
		t.Fatalf("空命令应报错，得到 %v", err)
	}
}

func TestStripContainerLogFrames(t *testing.T) {
	payload := []byte("第一行\nsecond\n")
	frame := []byte{1, 0, 0, 0}
	size := len(payload)
	frame = append(frame, byte(size>>24), byte(size>>16), byte(size>>8), byte(size))
	frame = append(frame, payload...)
	if got := StripContainerLogFrames(frame); got != "第一行\nsecond\n" {
		t.Fatalf("帧头应剥离拼接，得到 %q", got)
	}
	// 形状不符（size 越界）整段 UTF-8 兜底。
	malformed := append([]byte{1, 0, 0, 0, 0, 0, 9, 9}, []byte("残缺帧")...)
	if got := StripContainerLogFrames(malformed); !strings.Contains(got, "残缺帧") {
		t.Fatalf("畸形帧应整段兜底，得到 %q", got)
	}
}

func TestDockerStopQuery(t *testing.T) {
	transport := newFakeTransport()
	docker := newTestDocker(transport)
	if err := docker.Stop(context.Background(), testContainerID); err != nil {
		t.Fatalf("stop 应成功：%v", err)
	}
	call := transport.calls[0]
	if call.Path != "/containers/"+testContainerID+"/stop" {
		t.Fatalf("stop 路径不符：%s", call.Path)
	}
	if call.Query.Get("t") != "10" {
		t.Fatalf("stop 应带 t=10，得到 %v", call.Query)
	}
}

func TestDockerEnsureImageMissing(t *testing.T) {
	transport := newFakeTransport()
	docker := NewWebsiteDocker(transport, func(context.Context) ([]contract.ContainerImage, error) {
		return []contract.ContainerImage{{Name: "node", Tag: "20.0.0"}}, nil
	})
	if err := docker.EnsureImage(context.Background(), "node:20.0.0"); err != nil {
		t.Fatalf("精确匹配应通过：%v", err)
	}
	err := docker.EnsureImage(context.Background(), "node:24.21.0")
	if err == nil || !strings.Contains(err.Error(), "指定版本的运行时镜像尚未拉取：node:24.21.0") {
		t.Fatalf("缺失应 409 文案，得到 %v", err)
	}
	if err := docker.EnsureImage(context.Background(), ""); err == nil || err.Error() != "镜像引用无效" {
		t.Fatalf("空引用应报错，得到 %v", err)
	}
}

func TestDockerEnsureSiteDirEscape(t *testing.T) {
	// mkdir 钩子放行、realpath 越界 → 拒绝（防符号链接逃逸）。
	docker := &websiteDocker{
		mkdir:    func(string, os.FileMode) error { return nil },
		realpath: func(string) (string, error) { return "/srv/elsewhere", nil },
	}
	if _, err := docker.EnsureSiteDir("site", "/srv"); err == nil || err.Error() != "站点目录经过符号链接，已拒绝" {
		t.Fatalf("越界 realpath 应拒绝，得到 %v", err)
	}
}

func TestDockerRemoveManagedSelfProtection(t *testing.T) {
	transport := newFakeTransport()
	docker := newTestDocker(transport)
	_, err := docker.RemoveManaged(context.Background(), containerIdentity{
		ContainerID:     testContainerID,
		ContainerName:   testSiteContainerName,
		ProjectID:       "p",
		Kind:            KindHTML,
		Version:         "html",
		ImageRef:        WEBSITE_HTML_IMAGE,
		RootDir:         "/srv/wwwroot/site",
		SelfContainerID: testContainerID,
	})
	if err == nil || !strings.Contains(err.Error(), "不能删除面板自身容器") {
		t.Fatalf("自容器应保护，得到 %v", err)
	}
}

func TestDockerRemoveCreatedToleratesMissing(t *testing.T) {
	transport := &fakeTransport{response: func(seam.EngineRequest) seam.EngineResponse {
		return seam.EngineResponse{Status: 404, Body: nil}
	}}
	docker := newTestDocker(transport)
	if err := docker.RemoveCreated(context.Background(), testContainerID); err != nil {
		t.Fatalf("回滚删除 404 应视为成功：%v", err)
	}
	if err := docker.RemoveCreated(context.Background(), "bad-id"); err == nil || err.Error() != "容器 ID 无效" {
		t.Fatalf("非法 ID 应报错，得到 %v", err)
	}
}

func TestDockerIdentityMismatch(t *testing.T) {
	transport := &fakeTransport{response: func(req seam.EngineRequest) seam.EngineResponse {
		inspect := map[string]any{
			"Id":   testContainerID,
			"Name": "/" + testSiteContainerName,
			"Config": map[string]any{
				"Image":  "node:20.0.0",
				"Labels": map[string]any{},
			},
			"Mounts": []any{},
			"State":  map[string]any{"Running": false},
		}
		data, _ := marshalJSONCompact(inspect)
		return seam.EngineResponse{Status: 200, Body: data}
	}}
	docker := newTestDocker(transport)
	_, err := docker.RemoveManaged(context.Background(), containerIdentity{
		ContainerID: testContainerID, ContainerName: testSiteContainerName, ProjectID: "p",
		Kind: KindNode, Version: "24.21.0", ImageRef: "node:24.21.0", RootDir: "/srv/wwwroot/site",
	})
	if err == nil || !strings.Contains(err.Error(), "站点容器身份核对失败") {
		t.Fatalf("核对不过应 409，得到 %v", err)
	}
}

func TestDockerRemoveManagedMissing(t *testing.T) {
	transport := &fakeTransport{response: func(seam.EngineRequest) seam.EngineResponse {
		return seam.EngineResponse{Status: 404, Body: []byte(`{"message":"no such container"}`)}
	}}
	docker := newTestDocker(transport)
	result, err := docker.RemoveManaged(context.Background(), containerIdentity{
		ContainerID: testContainerID, ContainerName: testSiteContainerName, ProjectID: "p",
		Kind: KindNode, Version: "24.21.0", ImageRef: "node:24.21.0", RootDir: "/srv/wwwroot/site",
	})
	if err != nil || result != "missing" {
		t.Fatalf("容器已被外部删除应幂等 missing，得到 %s %v", result, err)
	}
}

func TestDockerLogsLineSplit(t *testing.T) {
	payload := "行一\n行二\n\n"
	frame := []byte{1, 0, 0, 0}
	frame = append(frame, byte(len(payload)>>24), byte(len(payload)>>16), byte(len(payload)>>8), byte(len(payload)))
	frame = append(frame, []byte(payload)...)
	transport := &fakeTransport{response: func(seam.EngineRequest) seam.EngineResponse {
		return seam.EngineResponse{Status: 200, Body: frame}
	}}
	docker := newTestDocker(transport)
	lines, err := docker.Logs(context.Background(), testContainerID)
	if err != nil {
		t.Fatalf("日志应读取成功：%v", err)
	}
	if len(lines) != 2 || lines[0] != "行一" || lines[1] != "行二" {
		t.Fatalf("应切分并滤空行，得到 %v", lines)
	}
	if transport.calls[0].Path != "/containers/"+testContainerID+"/logs" ||
		transport.calls[0].Query.Get("tail") != "200" ||
		transport.calls[0].Query.Get("stdout") != "1" ||
		transport.calls[0].Query.Get("stderr") != "1" {
		t.Fatalf("日志请求形状不符：%+v", transport.calls[0])
	}
}

func TestNormalizeMountRoot(t *testing.T) {
	base, err := wwwrootBase("/srv/")
	if err != nil || base != "/srv/wwwroot" {
		t.Fatalf("结尾斜杠应归一，得到 %s %v", base, err)
	}
	for _, root := range []string{"srv", "/srv/../etc", "/srv\x00"} {
		if _, err := normalizeMountRoot(root); err == nil || !strings.Contains(err.Error(), "无效的挂载根") {
			t.Fatalf("挂载根 %q 应拒绝，得到 %v", root, err)
		}
	}
}

func TestDockerRemoveSiteDirRealpathGuard(t *testing.T) {
	// rootDir 不在 wwwroot 前缀下 → 站点目录无效。
	docker := newTestDocker(newFakeTransport())
	if err := docker.RemoveSiteDir("/srv/other/site", "/srv"); err == nil || err.Error() != "站点目录无效" {
		t.Fatalf("前缀越界应拒绝，得到 %v", err)
	}
}
