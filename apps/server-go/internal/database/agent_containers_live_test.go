package database

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// Opt-in smoke: uses only an already installed mysql:8.4 image, a private
// registry, and a random test container with its own newly created volume.
func TestContainerBridgeLiveMySQL(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_CONTAINER_BRIDGE_LIVE") != "1" {
		t.Skip("未显式启用隔离容器 bridge 联调")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	name := "elysian-bridge-smoke-" + strings.ReplaceAll(newUUID(), "-", "")[:12]
	transport := &bridgeLiveTransport{name: name}
	transport.client = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", "/var/run/docker.sock")
	}}}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if transport.containerID == "" && len(transport.volumes) > 0 {
			// A lost create response is recoverable only when the exact test name
			// is bound to a volume this test created, never by name alone.
			response, err := transport.Request(cleanup, seam.EngineRequest{Method: "GET", Path: "/containers/" + name + "/json"})
			var info struct {
				ID     string `json:"Id"`
				Config struct {
					Labels map[string]string `json:"Labels"`
				} `json:"Config"`
			}
			if err == nil && response.Status == 200 && json.Unmarshal(response.Body, &info) == nil && containerIDPattern.MatchString(info.ID) {
				for _, volume := range transport.volumes {
					if info.Config.Labels["elysian.database.volume"] == volume {
						transport.containerID = info.ID
					}
				}
			}
		}
		// The transport admits deletion only for this run's generated resources.
		for _, target := range []string{transport.containerID} {
			if target == "" {
				continue
			}
			response, err := transport.Request(cleanup, seam.EngineRequest{Method: "DELETE", Path: "/containers/" + target, Query: map[string][]string{"force": {"true"}}})
			if err != nil || response.Status != 204 && response.Status != 404 {
				t.Error("隔离测试容器清理失败")
			}
		}
		for _, volume := range transport.volumes {
			response, err := transport.Request(cleanup, seam.EngineRequest{Method: "DELETE", Path: "/volumes/" + volume})
			if err != nil || response.Status != 204 && response.Status != 404 {
				t.Error("隔离测试专属卷清理失败")
			}
		}
	})
	response, err := transport.Request(ctx, seam.EngineRequest{Method: "GET", Path: "/images/mysql:8.4/json"})
	var image struct {
		ID string `json:"Id"`
	}
	if err != nil || response.Status != 200 || json.Unmarshal(response.Body, &image) != nil || !containerIDPattern.MatchString(stripSha256Prefix(image.ID)) {
		t.Fatal("本机缺少可用的 mysql:8.4；本测试不拉取镜像")
	}
	images := func(context.Context) ([]contract.ContainerImage, error) {
		return []contract.ContainerImage{{ID: stripSha256Prefix(image.ID), Name: "mysql", Tag: "8.4"}}, nil
	}
	service := newDatabaseService(serviceDeps{registry: newFileDatabaseRegistry(filepath.Join(t.TempDir(), "databases.json")), docker: newDockerAPI(transport, images), protocol: newProtocolAPI(), listImages: images})
	facade := &AgentFacade{service: service}
	bridge := facade.ContainerBridge(func(context.Context) error { return nil })
	input := seam.AgentServiceContainerInput{Name: name, Image: "mysql:8.4@" + image.ID, RequestID: strings.Repeat("a", 64), ResourceTier: "medium", NetworkScope: "container-net", Credentials: []string{"MYSQL_ROOT_PASSWORD"}, Env: []string{"MYSQL_DATABASE=orders"}, Volumes: []string{"/var/lib/mysql"}}
	run, handled, err := bridge.PrepareCreate(ctx, input, image.ID)
	if err != nil || !handled {
		t.Fatalf("真实 bridge 准备失败：handled=%v error=%v", handled, err)
	}
	receipt, err := run(ctx)
	if err != nil {
		t.Fatalf("真实 bridge 创建失败：%v", err)
	}
	rows, err := service.deps.registry.list()
	if err != nil || len(rows) != 1 || rows[0].State != stateActive || rows[0].ContainerName != name {
		t.Fatal("真实创建未同步到私有登记")
	}
	secret, err := service.Reveal(ctx, rows[0].ID)
	if err != nil || secret.Password == "" || secret != rows[0].User {
		t.Fatal("真实数据库普通凭据不可用")
	}
	raw, _ := json.Marshal(receipt)
	if strings.Contains(string(raw), secret.Password) || strings.Contains(string(raw), rows[0].Admin.Password) {
		t.Fatal("真实回执泄漏数据库凭据")
	}
	for _, action := range []string{"create", "remove"} {
		rows, _ = service.deps.registry.list()
		change, err := bridge.PrepareChange(ctx, rows[0].ContainerID, strings.Repeat("b", 64), seam.AgentDatabaseChange{Action: action, Name: "archive", ExpectedRevision: containerRevision(rows)})
		if err != nil {
			t.Fatalf("真实逻辑库准备失败：%v", err)
		}
		if _, err := change(ctx); err != nil {
			t.Fatalf("真实逻辑库变更失败：%v", err)
		}
	}
	rows, _ = service.deps.registry.list()
	if len(rows) != 1 || rows[0].Name != "orders" {
		t.Fatal("真实逻辑库删除影响了原登记")
	}
	stopped, err := transport.Request(ctx, seam.EngineRequest{Method: "POST", Path: "/containers/" + rows[0].ContainerID + "/stop"})
	if err != nil || stopped.Status != http.StatusNoContent {
		t.Fatalf("停止隔离测试容器失败：%v", err)
	}
	before := containerRevision(rows)
	change, err := bridge.PrepareChange(ctx, rows[0].ContainerID, strings.Repeat("c", 64), seam.AgentDatabaseChange{Action: "remove", Name: "orders", ExpectedRevision: before})
	if err != nil {
		t.Fatal(err)
	}
	_, err = change(ctx)
	var rejected *seam.AgentContainerError
	if !errors.As(err, &rejected) || !rejected.NoBusinessEffect || rejected.NotDispatched || rejected.Message != "数据库容器未运行，数据库变更未执行" {
		t.Fatalf("停止态删库没有明确的已受理、无业务变更回执：%v", err)
	}
	rows, err = service.deps.registry.list()
	if err != nil || containerRevision(rows) != before {
		t.Fatal("停止态删库失败改变了登记")
	}
	if _, err := bridge.Inspect(ctx, rows[0].ContainerID, nil); err != nil {
		t.Fatalf("已确认失败后无法读取登记摘要：%v", err)
	}
	inspected, err := transport.Request(ctx, seam.EngineRequest{Method: "GET", Path: "/containers/" + rows[0].ContainerID + "/json"})
	if err != nil || inspected.Status != http.StatusOK {
		t.Fatalf("停止态失败后 Docker inspect 不可用：%v", err)
	}
	handled, err = bridge.Lifecycle(ctx, rows[0].ContainerID, "remove")
	if err != nil || !handled {
		t.Fatalf("真实受管容器删除失败：%v", err)
	}
	rows, err = service.deps.registry.list()
	if err != nil || len(rows) != 0 {
		t.Fatal("删除容器后私有登记残留")
	}
	t.Log("真实 MySQL 创建、凭据、逻辑库增删、停止态删库无变更、后续 inspect 及容器/卷清理通过")
}

// The test transport fails closed around mutations and never reads panel state.
type bridgeLiveTransport struct {
	client            *http.Client
	name, containerID string
	volumes           []string
}

func (s *bridgeLiveTransport) Request(ctx context.Context, input seam.EngineRequest) (seam.EngineResponse, error) {
	allowed := input.Method == "GET"
	if input.Method == "POST" && input.Path == "/volumes/create" {
		var body struct {
			Name string `json:"Name"`
		}
		if json.Unmarshal(input.Body, &body) == nil && managedVolumeNamePattern.MatchString(body.Name) {
			s.volumes = append(s.volumes, body.Name)
			allowed = true
		}
	}
	if input.Method == "POST" && input.Path == "/containers/create" && input.Query.Get("name") == s.name {
		allowed = true
	}
	if s.containerID != "" && input.Method == "POST" && (input.Path == "/containers/"+s.containerID+"/start" || input.Path == "/containers/"+s.containerID+"/stop") {
		allowed = true
	}
	if input.Method == "DELETE" {
		allowed = s.containerID != "" && input.Path == "/containers/"+s.containerID
		for _, volume := range s.volumes {
			allowed = allowed || input.Path == "/volumes/"+volume
		}
	}
	if !allowed {
		return seam.EngineResponse{}, errors.New("隔离测试拒绝未声明的 Docker 写操作")
	}
	deadline := input.Timeout
	if deadline <= 0 {
		deadline = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	target := "http://localhost" + seam.EngineAPIPrefix + input.Path
	if len(input.Query) > 0 {
		target += "?" + input.Query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, input.Method, target, bytes.NewReader(input.Body))
	if err != nil {
		return seam.EngineResponse{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return seam.EngineResponse{}, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return seam.EngineResponse{}, err
	}
	if input.Method == "POST" && input.Path == "/containers/create" && response.StatusCode == 201 {
		var created struct {
			ID string `json:"Id"`
		}
		if json.Unmarshal(body, &created) == nil && containerIDPattern.MatchString(created.ID) {
			s.containerID = created.ID
		}
	}
	return seam.EngineResponse{Status: response.StatusCode, Body: body}, nil
}

func (*bridgeLiveTransport) Stream(context.Context, seam.EngineRequest, func([]byte)) (seam.EngineResponse, error) {
	return seam.EngineResponse{}, errors.New("隔离测试没有流式操作")
}
