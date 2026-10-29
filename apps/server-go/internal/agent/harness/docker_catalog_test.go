package harness

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/tools"
	dockertools "elysian/server/internal/agent/tools/docker"
	"elysian/server/internal/config"
	"elysian/server/internal/contract"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/seam"
)

type dockerCatalogViews struct{ images atomic.Int32 }

func (v *dockerCatalogViews) ListImages(context.Context) ([]contract.ContainerImage, error) {
	v.images.Add(1)
	return []contract.ContainerImage{{ID: strings.Repeat("a", 64), Name: "local-nginx", Tag: "1.27", SizeMB: 192}}, nil
}
func (*dockerCatalogViews) ListContainers(context.Context) ([]contract.Container, error) {
	return nil, nil
}
func (*dockerCatalogViews) Policy() seam.DockerPolicy { return seam.DockerPolicy{} }
func (*dockerCatalogViews) SelfContainerID() string   { return "" }

func dockerCatalogBridge(t *testing.T) (*toolbridge.Bridge, *dockerCatalogViews) {
	t.Helper()
	views := &dockerCatalogViews{}
	// Unix socket paths are limited to 108 bytes on Linux; subtest names exceed it.
	root, err := os.MkdirTemp("", "ely-docker-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	socket := filepath.Join(root, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.URL.Path, seam.EngineAPIPrefix) {
		case "/version":
			_, _ = w.Write([]byte(`{"ApiVersion":"1.44"}`))
		case "/containers/json":
			_, _ = w.Write([]byte(`[]`))
		case "/containers/" + strings.Repeat("c", 64) + "/json":
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": strings.Repeat("c", 64), "Name": "/local-web", "Image": "sha256:" + strings.Repeat("a", 64), "Created": "2026-10-29T00:00:00Z", "State": map[string]any{"Status": "running"}, "Config": map[string]any{"Image": "local-nginx:1.27", "Cmd": []string{"secret-command"}, "Env": []string{"TOKEN=secret-token"}}, "HostConfig": map[string]any{}, "Mounts": []any{}})
		case "/images/" + strings.Repeat("a", 64) + "/json":
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "sha256:" + strings.Repeat("a", 64), "Size": 192 * 1024 * 1024, "Created": "2026-10-29T00:00:00Z", "RepoTags": []string{"local-nginx:1.27"}, "RepoDigests": []string{"local-nginx@sha256:" + strings.Repeat("a", 64)}, "Config": map[string]any{"Env": []string{"TOKEN=secret-token"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	stack, err := domaindocker.Assemble(domaindocker.Deps{Mode: config.ModeBareMetal, SocketPath: socket, AgentAuthorize: func(ctx context.Context) error { return tools.ConsumeBackend(ctx, tools.DispatchID(ctx)) }})
	if err != nil || !stack.Ready {
		t.Fatalf("fake Engine unavailable: %v", err)
	}
	t.Cleanup(func() {
		if err := stack.Agent.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	bridge, err := toolbridge.NewWithPlugins(views, dockertools.Plugin(dockertools.Deps{Views: views, Agent: stack.Agent}, dockertools.Config{ListLimit: 201}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := bridge.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return bridge, views
}

func saveOldDockerSelection(t *testing.T, m *Manager, session Session) Environment {
	t.Helper()
	ctx := context.Background()
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	env.Tools = []string{"docker_image_pull_get", "docker_image_pull_logs", "docker_image_pull_cancel"}
	env, err = m.PutEnvironment(ctx, session.ID, env.Revision, env)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func dockerSnapshotTool(snapshot CapabilitySnapshot, name string) (Capability, bool) {
	for _, capability := range snapshot.Tools {
		if capability.Name == name {
			return capability, true
		}
	}
	return Capability{}, false
}

func TestDockerNewRunsRefreshCatalogWithoutChangingSavedEnvironmentOrOldSnapshots(t *testing.T) {
	bridge, _ := dockerCatalogBridge(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("done"), nil
	}, func(d *Deps) { d.Tools = bridge })
	ctx := context.Background()
	oldEnv := saveOldDockerSelection(t, m, session)
	oldSnapshot, err := m.snapshot(ctx, oldEnv)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := dockerSnapshotTool(oldSnapshot, "docker_images_list"); ok {
		t.Fatal("legacy snapshot unexpectedly expanded")
	}
	oldBytes, _ := json.Marshal(oldSnapshot)
	first := submitAgentTest(t, m, session, "docker-new", "列出镜像")
	if run := runtimeFinished(t, m, first.ID); run.Status != StateSucceeded {
		t.Fatalf("new run: %+v", run)
	}
	continued, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "docker-continue", Content: "再看一次"})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, continued.ID); run.Status != StateSucceeded {
		t.Fatalf("continued run: %+v", run)
	}
	messages, err := m.Messages(ctx, session.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	var lastUser string
	for _, message := range messages.Items {
		if message.Role == "user" {
			lastUser = message.ID
		}
	}
	edited, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "docker-edit", Content: "查看本地容器", ReplaceMessageID: lastUser})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, edited.ID); run.Status != StateSucceeded {
		t.Fatalf("edited run: %+v", run)
	}
	for _, run := range []Run{first, continued, edited} {
		for _, schema := range bridge.Schemas() {
			c, ok := dockerSnapshotTool(*run.Snapshot, schema.Name)
			if !ok || c.Source != "builtin" || c.CatalogDigest == "" || !reflect.DeepEqual(c.SearchNames, schema.SearchNames) {
				t.Fatalf("run %s lost registered tool %s: %+v", run.ID, schema.Name, c)
			}
		}
		if run.Snapshot.ToolLoading != onDemandToolsV2 || len(run.Snapshot.EagerTools) != 0 {
			t.Fatalf("Docker suite was eagerly injected: %+v", run.Snapshot)
		}
	}
	saved, err := m.GetEnvironment(ctx, session.ID)
	if err != nil || !reflect.DeepEqual(saved, oldEnv) {
		t.Fatalf("saved environment changed: %+v %v", saved, err)
	}
	stillOld, _ := json.Marshal(oldSnapshot)
	if string(stillOld) != string(oldBytes) {
		t.Fatal("accepted old snapshot changed")
	}
}

func TestDockerSearchFindsLocalListsBeforePullTaskObservers(t *testing.T) {
	bridge, _ := dockerCatalogBridge(t)
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) { d.Tools = bridge })
	snapshot, err := m.snapshotForAgent(context.Background(), Environment{}, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ query, want string }{
		{"现在系统里面有什么 docker 镜像", "docker_images_list"},
		{"镜像列表 images", "docker_images_list"},
		{"docker images list", "docker_images_list"},
		{"容器列表", "docker_containers_list"},
		{"docker ps", "docker_containers_list"},
		{"容器详情", "docker_container_inspect"},
		{"docker image inspect", "docker_image_inspect"},
		{"docker_image_pull", "docker_image_pull"},
	} {
		raw, _ := json.Marshal(map[string]any{"query": test.query})
		result, err := searchTools(snapshot, raw)
		var page toolSearchResult
		if err != nil || json.Unmarshal(result.Value, &page) != nil || len(page.Matches) == 0 || page.Matches[0].Name != test.want {
			t.Errorf("query=%q want=%s result=%s err=%v", test.query, test.want, result.Value, err)
		}
	}
	result, err := searchTools(snapshot, json.RawMessage(`{"query":"docker"}`))
	var page toolSearchResult
	if err != nil || json.Unmarshal(result.Value, &page) != nil {
		t.Fatal(err)
	}
	var names []string
	for _, match := range page.Matches {
		names = append(names, match.Name)
	}
	if !contains(names, "docker_images_list") || !contains(names, "docker_containers_list") {
		t.Fatalf("generic Docker search hid local lists: %s", result.Value)
	}
}

func TestDockerDetailsExecuteThroughKardiaWithExactAuthorization(t *testing.T) {
	for _, test := range []struct{ name, id, want string }{
		{"docker_container_inspect", strings.Repeat("c", 64), "local-web"},
		{"docker_image_inspect", strings.Repeat("a", 64), "local-nginx"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bridge, _ := dockerCatalogBridge(t)
			var step atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				switch step.Add(1) {
				case 1:
					return searchReply(test.name), nil
				case 2:
					response := toolReply(test.name)
					response.ToolCalls[0].Arguments, _ = json.Marshal(map[string]string{"id": test.id})
					return response, nil
				default:
					text := allRequestText(request)
					if !strings.Contains(text, test.want) || strings.Contains(text, "secret-command") || strings.Contains(text, "secret-token") {
						t.Errorf("invalid detail projection: %s", text)
					}
					return finalReply("已核对本地对象"), nil
				}
			}, func(d *Deps) { d.Tools = bridge })
			run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "docker-detail", Content: "查看详情", AuthorizationMode: AuthorizationOnDemand})
			if err != nil {
				t.Fatal(err)
			}
			finished := runtimeFinished(t, m, run.ID)
			if finished.Status != StateSucceeded {
				t.Fatalf("detail failed: status=%s error=%+v", finished.Status, finished.Error)
			}
			approvals, err := m.ApprovalsByRun(context.Background(), "", run.ID)
			if err != nil || len(approvals) != 0 {
				t.Fatalf("detail required approval: %+v %v", approvals, err)
			}
		})
	}
}

func TestDockerKardiaExecutionAndDiscoveryKeepStablePromptCachePrefix(t *testing.T) {
	bridge, views := dockerCatalogBridge(t)
	var step atomic.Int32
	var mu sync.Mutex
	var requests []model.Request
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		switch step.Add(1) {
		case 1:
			return searchReply("docker_images_list"), nil
		case 2:
			return toolReply("docker_images_list"), nil
		case 3:
			if !strings.Contains(allRequestText(request), "local-nginx") {
				t.Error("local image result did not reach model")
			}
			return searchReply("docker_container_inspect"), nil
		case 4:
			return searchReply("docker_container_start"), nil
		case 5:
			return searchReply("docker_images_list"), nil
		default:
			return finalReply("本地有 local-nginx:1.27"), nil
		}
	}, func(d *Deps) { d.Tools = bridge })
	saveOldDockerSelection(t, m, session)
	run := submitAgentTest(t, m, session, "docker-cache", "现在系统里面有什么 docker 镜像")
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded || views.images.Load() != 1 {
		calls, _ := m.Calls(context.Background(), run.ID, "", 50)
		raw, _ := json.Marshal(calls)
		t.Fatalf("run error=%+v list calls=%d calls=%s", finished.Error, views.images.Load(), raw)
	}
	mu.Lock()
	captured := append([]model.Request(nil), requests...)
	mu.Unlock()
	if len(captured) != 6 {
		t.Fatalf("requests=%d", len(captured))
	}
	if len(captured[0].Tools) != 3 {
		t.Fatalf("initial catalog injected: tools=%v", toolNamesOf(captured[0].Tools))
	}
	for index := 1; index < len(captured); index++ {
		requireRequestPrefix(t, captured[index-1], captured[index])
		requireToolNamesPrefix(t, captured[index-1].Tools, captured[index].Tools)
		if captured[index].Messages[0].Content != captured[0].Messages[0].Content || captured[index].Messages[1].Content != captured[0].Messages[1].Content {
			t.Fatal("stable header changed with Docker results or loaded tools")
		}
	}
	last := captured[len(captured)-1]
	names := toolNamesOf(last.Tools)
	if len(names) != 6 || !reflect.DeepEqual(names[3:], []string{"docker_images_list", "docker_container_inspect", "docker_container_start"}) {
		t.Fatalf("discovery reordered existing definitions: %v", names)
	}
	rawTools, _ := json.Marshal(last.Tools)
	if strings.Contains(string(rawTools), "searchNames") || strings.Contains(string(rawTools), "已安装镜像") {
		t.Fatalf("search-only aliases leaked to model definitions: %s", rawTools)
	}
	order, err := (&agentExecution{manager: m, run: finished}).loadedToolOrder(context.Background(), *finished.Snapshot)
	if err != nil || !reflect.DeepEqual(order, names[3:]) {
		t.Fatalf("persisted discovery order changed: %v %v", order, err)
	}
	approvals, err := m.ApprovalsByRun(context.Background(), "", run.ID)
	if err != nil || len(approvals) != 0 {
		t.Fatalf("confirmed local reads required approval: %+v %v", approvals, err)
	}
}

type dockerSelectionTools struct {
	runtimeTestTools
	schemas []tools.PublicSchema
}

func (t *dockerSelectionTools) Schemas() []tools.PublicSchema { return t.schemas }

func TestDockerAutomaticCatalogNeverAddsUnreviewedOrHumanTools(t *testing.T) {
	registered := []tools.PublicSchema{
		{Name: "docker_images_list", Metadata: tools.Metadata{Domain: "docker", Exposure: "human"}},
		{Name: "docker_engine_request", Metadata: tools.Metadata{Domain: "docker", Exposure: "agent"}},
		{Name: "docker_container_inspect", Metadata: tools.Metadata{Domain: "other", Exposure: "agent"}},
	}
	m := &Manager{deps: Deps{Tools: &dockerSelectionTools{schemas: registered}}}
	before := Environment{Tools: []string{"already_selected"}}
	if got := m.withDockerTools(before); !reflect.DeepEqual(got, before) {
		t.Fatalf("unaudited tools added: %+v", got)
	}
}
