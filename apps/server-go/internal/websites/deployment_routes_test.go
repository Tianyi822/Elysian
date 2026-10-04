package websites

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeploymentSourceAndResumeRoutes(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	m := newDeploymentManager(f.service, deploymentEngine{limits: defaultDeploymentLimits()}, t.TempDir(), t.TempDir(), t.TempDir())
	r := chi.NewRouter()
	mountDeploymentRoutes(r, m)
	var archive bytes.Buffer
	zipper := zip.NewWriter(&archive)
	out, _ := zipper.Create("project/index.html")
	_, _ = out.Write([]byte("<h1>ok</h1>"))
	_ = zipper.Close()
	request := httptest.NewRequest("POST", "/sources/archive?mode=artifact", bytes.NewReader(archive.Bytes()))
	request.Header.Set("X-File-Name", "fixture.zip")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	if response.Code != 201 {
		t.Fatalf("上传接口：%d %s", response.Code, response.Body.String())
	}
	var source sourceRecord
	if json.Unmarshal(response.Body.Bytes(), &source) != nil || source.State != "ready" || len(source.Report.Candidates) != 1 {
		t.Fatal("没有解压并识别唯一目录")
	}
	id := newDeploymentID()
	now := time.Now().UTC().Format(time.RFC3339)
	cfg := buildConfig{CandidateID: source.Report.Candidates[0].ID, Target: "static"}
	task := deploymentTask{ID: id, SourceID: source.ID, Name: "fixture", Port: 8080, State: "awaiting-config", Config: cfg, CreatedAt: now, UpdatedAt: now, Input: deploymentInput{Config: cfg}, TestResult: "skipped"}
	m.tasks[id] = &task
	m.workers <- struct{}{} // 保持队列等待，核对取消和继续接口而不运行引擎。
	defer func() { <-m.workers }()
	call := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		r.ServeHTTP(response, request)
		return response
	}
	if response := call("GET", "/sources/"+source.ID+"/analysis", ""); response.Code != 200 {
		t.Fatal("识别查询失败")
	}
	if response := call("DELETE", "/sources/"+source.ID, ""); response.Code != 409 {
		t.Fatal("等待配置时允许删除来源")
	}
	body, _ := json.Marshal(cfg)
	if response := call("POST", "/deployments/"+id+"/resume", string(body)); response.Code != 202 {
		t.Fatalf("继续失败：%s", response.Body.String())
	}
	if response := call("POST", "/deployments/"+id+"/resume", string(body)); response.Code != 409 {
		t.Fatal("重复继续未拦截")
	}
	if response := call("POST", "/deployments/"+id+"/cancel", "{}"); response.Code != 202 {
		t.Fatal("取消失败")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		actual, _ := m.getTask(id)
		if actual.State == "cancelled" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	actual, _ := m.getTask(id)
	if actual.State != "cancelled" {
		t.Fatal("排队任务未取消")
	}
	_ = os.WriteFile(filepath.Join(m.logRoot, id+".log"), []byte("第一行\n第二行\n"), 0600)
	if response := call("GET", "/deployments/"+id+"/logs?offset=10", ""); response.Code != 200 || !strings.Contains(response.Body.String(), "第二行") {
		t.Fatal("分页日志失败")
	}
	if response := call("GET", "/deployments/"+id+"/logs?offset=-1", ""); response.Code != 400 {
		t.Fatal("无效分页未拦截")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.archive(ctx, "cancel.zip", "source", bytes.NewReader(archive.Bytes())); err == nil {
		t.Fatal("取消上传未停止")
	}
}

func TestDeploymentProjectStatusResponses(t *testing.T) {
	f := fixture(t, nil, nil, nil, nil)
	m := newDeploymentManager(f.service, deploymentEngine{limits: defaultDeploymentLimits()}, t.TempDir(), t.TempDir(), t.TempDir())
	if err := f.registry.Put(context.Background(), WebsiteRecord{ID: "existing"}); err != nil {
		t.Fatal(err)
	}
	tasks := []deploymentTask{
		{ID: "current", ProjectID: "existing", State: "succeeded"},
		{ID: "history", ProjectID: "removed", State: "succeeded", Release: &releaseRecord{}},
		{ID: "publishing", ProjectID: "new", State: "publishing", Pending: &WebsiteRecord{ID: "new"}},
		{ID: "failed-new", State: "failed"},
		{ID: "redeploy", ProjectID: "removed", State: "failed", Input: deploymentInput{ProjectID: "removed"}},
	}
	want := map[string]string{"current": "present", "history": "deleted", "publishing": "not-created", "failed-new": "not-created", "redeploy": "deleted"}
	for i := range tasks {
		task := tasks[i]
		m.tasks[task.ID] = &task
	}
	r := chi.NewRouter()
	mountDeploymentRoutes(r, m)
	for _, path := range []string{"/deployments", "/deployments/history", "/deployments/publishing"} {
		response := httptest.NewRecorder()
		r.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			t.Fatal(response.Body.String())
		}
		var rows []deploymentTask
		if path == "/deployments" {
			if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
				t.Fatal(err)
			}
		} else {
			var task deploymentTask
			if err := json.Unmarshal(response.Body.Bytes(), &task); err != nil {
				t.Fatal(err)
			}
			rows = []deploymentTask{task}
		}
		for _, row := range rows {
			if row.ProjectStatus != want[row.ID] {
				t.Fatalf("%s 项目状态错误：%s", row.ID, row.ProjectStatus)
			}
		}
	}
	for _, task := range m.tasks {
		if task.ProjectStatus != "" {
			t.Fatal("只读状态写入了历史内存数据")
		}
	}
}
