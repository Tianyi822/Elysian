package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/shared"
)

type routeRuntimeStub struct {
	run        Run
	duplicate  bool
	err        error
	submits    int
	input      SubmitInput
	query      ListQuery
	lastID     string
	lastCursor string
	lastLimit  int
}

func (s *routeRuntimeStub) Info() RuntimeInfo {
	return RuntimeInfo{Available: true, Worker: "ready", Storage: "ready", Limits: DefaultLimits()}
}
func (s *routeRuntimeStub) Submit(_ context.Context, input SubmitInput) (Run, bool, error) {
	s.submits++
	s.input = input
	return s.run, s.duplicate, s.err
}
func (s *routeRuntimeStub) List(_ context.Context, query ListQuery) (Page[Run], error) {
	s.query = query
	return Page[Run]{}, s.err
}
func (s *routeRuntimeStub) Get(_ context.Context, id string) (Run, error) {
	s.lastID = id
	return s.run, s.err
}
func (s *routeRuntimeStub) Calls(_ context.Context, id, cursor string, limit int) (Page[Call], error) {
	s.lastID, s.lastCursor, s.lastLimit = id, cursor, limit
	return Page[Call]{}, s.err
}
func (s *routeRuntimeStub) Events(_ context.Context, id, after string, limit int) (Page[Event], error) {
	s.lastID, s.lastCursor, s.lastLimit = id, after, limit
	return Page[Event]{}, s.err
}
func (s *routeRuntimeStub) Cancel(_ context.Context, id string) (Run, error) {
	s.lastID = id
	return s.run, s.err
}

func runtimeRouteRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	router.Mount("/api/agent", handler)
	req := httptest.NewRequest(method, "http://localhost/api/agent"+path, strings.NewReader(body))
	req.Header.Set("Origin", "http://localhost")
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func TestRuntimeRoutesSubmitAndIdempotentResponse(t *testing.T) {
	stub := &routeRuntimeStub{run: Run{ID: "run-1", TaskID: "task-1", Status: StateQueued, LastSeq: "1"}}
	handler := newRuntimeRouter(stub, "")
	body := `{"requestId":"request-1","kind":"tool-batch","steps":[{"tool":"docker_containers_list","args":{}}]}`
	first := runtimeRouteRequest(handler, http.MethodPost, "/runs", body)
	if first.Code != http.StatusAccepted || first.Header().Get("Location") != "/api/agent/runs/run-1" {
		t.Fatalf("新任务响应错误：%d %s", first.Code, first.Body.String())
	}
	if stub.input.RequestID != "request-1" || len(stub.input.Steps) != 1 || stub.input.Steps[0].Tool != "docker_containers_list" {
		t.Fatalf("提交输入丢失：%+v", stub.input)
	}
	stub.duplicate = true
	second := runtimeRouteRequest(handler, http.MethodPost, "/runs", body)
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() {
		t.Fatalf("幂等命中未返回相同运行：%d %s", second.Code, second.Body.String())
	}
}

func TestRuntimeRoutesRejectMalformedBodiesBeforeSubmission(t *testing.T) {
	for _, body := range []string{
		`null`, `[]`, `true`, `{"kind":`,
		`{"kind":"tool-batch","unexpected":true}`,
		`{"steps":[{"tool":"docker_containers_list","args":{},"script":"echo hi"}]}`,
		`{"steps":[{"tool":"docker_containers_list","args":[]}]}`,
		`{"requestId":42}`,
	} {
		t.Run(body, func(t *testing.T) {
			stub := &routeRuntimeStub{}
			response := runtimeRouteRequest(newRuntimeRouter(stub, ""), http.MethodPost, "/runs", body)
			if response.Code != http.StatusBadRequest || stub.submits != 0 {
				t.Fatalf("非法请求触达提交：%d %+v", response.Code, stub)
			}
		})
	}
}

func TestRuntimeRoutesOriginAndBodyGuards(t *testing.T) {
	tests := []struct {
		name, origin, contentType, body string
		unknownLength                   bool
		status                          int
	}{
		{name: "缺少来源", contentType: "application/json", body: `{}`, status: 403},
		{name: "跨站来源", origin: "http://elsewhere.example", contentType: "application/json", body: `{}`, status: 403},
		{name: "非JSON", origin: "http://localhost", contentType: "text/plain", body: `{}`, status: 415},
		{name: "空请求体", origin: "http://localhost", contentType: "application/json", status: 400},
		{name: "申报超限", origin: "http://localhost", contentType: "application/json", body: strings.Repeat(" ", 65537), status: 413},
		{name: "流式超限", origin: "http://localhost", contentType: "application/json", body: strings.Repeat(" ", 65537), unknownLength: true, status: 413},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stub := &routeRuntimeStub{}
			req := httptest.NewRequest(http.MethodPost, "http://localhost/runs", strings.NewReader(test.body))
			req.Header.Set("Origin", test.origin)
			req.Header.Set("Content-Type", test.contentType)
			if test.unknownLength {
				req.ContentLength = -1
			}
			response := httptest.NewRecorder()
			newRuntimeRouter(stub, "").ServeHTTP(response, req)
			if response.Code != test.status || stub.submits != 0 {
				t.Fatalf("守卫未生效：%d %s", response.Code, response.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["error"] == "" || body["code"] == "" {
				t.Fatalf("错误正文缺少中文消息或错误码：%s", response.Body.String())
			}
		})
	}
}

func TestRuntimeRoutesPaginationAndExactEventCursor(t *testing.T) {
	stub := &routeRuntimeStub{}
	handler := newRuntimeRouter(stub, "")
	for _, path := range []string{"/runs", "/runs/run-1/calls", "/runs/run-1/events"} {
		response := runtimeRouteRequest(handler, http.MethodGet, path, "")
		if response.Code != http.StatusOK || response.Body.String() != `{"items":[],"nextCursor":"","hasMore":false}` {
			t.Fatalf("空分页契约错误：%s %d %s", path, response.Code, response.Body.String())
		}
	}
	if stub.query.Limit != 50 || stub.lastLimit != 100 {
		t.Fatalf("默认分页上限错误：%+v %+v", stub.query, stub)
	}
	response := runtimeRouteRequest(handler, http.MethodGet, "/runs?status=interrupted&requestId=request-1&cursor=next&limit=200", "")
	if response.Code != 200 || stub.query != (ListQuery{Status: StateInterrupted, RequestID: "request-1", Cursor: "next", Limit: 200}) {
		t.Fatalf("筛选参数丢失：%d %+v", response.Code, stub.query)
	}
	response = runtimeRouteRequest(handler, http.MethodGet, "/runs/run-1/events?after=9007199254740993&limit=1", "")
	if response.Code != 200 || stub.lastID != "run-1" || stub.lastCursor != "9007199254740993" || stub.lastLimit != 1 {
		t.Fatalf("事件序号被截断：%d %+v", response.Code, stub)
	}
	response = runtimeRouteRequest(handler, http.MethodGet, "/runs/run-1/calls?cursor=step-2&limit=2", "")
	if response.Code != 200 || stub.lastCursor != "step-2" || stub.lastLimit != 2 {
		t.Fatalf("工具调用游标丢失：%d %+v", response.Code, stub)
	}
}

func TestRuntimeRoutesRejectInvalidQueries(t *testing.T) {
	handler := newRuntimeRouter(&routeRuntimeStub{}, "")
	for _, path := range []string{
		"/runs?limit=0", "/runs?limit=201", "/runs?limit=1.5", "/runs?limit=abc",
		"/runs?limit=1&limit=2", "/runs?limit=", "/runs?status=invalid-status",
		"/runs?unknown=1", "/runs?cursor=%zz", "/runs?cursor=" + strings.Repeat("a", 257),
		"/runs/run-1/events?after=-1", "/runs/run-1/events?after=1.2", "/runs/run-1/events?after=9223372036854775808",
		"/runs/run-1/events?after=%2B1", "/runs/run-1/events?after=1&after=2",
	} {
		t.Run(path, func(t *testing.T) {
			response := runtimeRouteRequest(handler, http.MethodGet, path, "")
			if response.Code != http.StatusBadRequest {
				t.Fatalf("非法参数未拒绝：%d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestRuntimeRoutesCancellationWaitsForTerminalState(t *testing.T) {
	for _, state := range []string{StateQueued, StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted} {
		t.Run(state, func(t *testing.T) {
			stub := &routeRuntimeStub{run: Run{ID: "run-1", Status: state, CancelRequestedAt: "2026-10-10T00:00:00Z"}}
			response := runtimeRouteRequest(newRuntimeRouter(stub, ""), http.MethodPost, "/runs/run-1/cancel", "")
			status := http.StatusOK
			if state == StateQueued || state == StateRunning {
				status = http.StatusAccepted
			}
			if response.Code != status || stub.lastID != "run-1" {
				t.Fatalf("取消状态错误：%d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestRuntimeRoutesUnavailableNeverCreatesDemoRuns(t *testing.T) {
	handler := UnavailableRouter("本地演示模式未启用真实运行服务")
	response := runtimeRouteRequest(handler, http.MethodGet, "/runtime", "")
	var info RuntimeInfo
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &info) != nil || info.Available || info.Reason == "" || info.Tools == nil {
		t.Fatalf("不可用报告不完整：%d %s", response.Code, response.Body.String())
	}
	for _, request := range []struct{ method, path string }{
		{"GET", "/runs"}, {"POST", "/runs"}, {"GET", "/runs/run-1"},
		{"GET", "/runs/run-1/calls"}, {"GET", "/runs/run-1/events"}, {"POST", "/runs/run-1/cancel"},
	} {
		response := runtimeRouteRequest(handler, request.method, request.path, `{}`)
		if response.Code != 503 || !strings.Contains(response.Body.String(), `"code":"unavailable"`) {
			t.Fatalf("不可用服务返回了任务：%s %d %s", request.path, response.Code, response.Body.String())
		}
	}
}

func TestRuntimeRoutesMapServiceFailures(t *testing.T) {
	for _, status := range []int{400, 404, 409, 410, 429, 503} {
		stub := &routeRuntimeStub{err: &Error{Status: status, Code: "service-error", Message: "任务请求未完成"}}
		response := runtimeRouteRequest(newRuntimeRouter(stub, ""), http.MethodGet, "/runs/run-1", "")
		if response.Code != status || response.Body.String() != `{"error":"任务请求未完成","code":"service-error"}` {
			t.Fatalf("服务错误映射错误：%d %s", response.Code, response.Body.String())
		}
	}
	stub := &routeRuntimeStub{err: errors.New("内部存储故障细节")}
	response := runtimeRouteRequest(newRuntimeRouter(stub, ""), http.MethodGet, "/runs/run-1", "")
	if response.Code != 500 || strings.Contains(response.Body.String(), "内部存储故障细节") {
		t.Fatalf("内部错误未正确收口：%d %s", response.Code, response.Body.String())
	}
}

func TestRuntimeContractSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../../packages/foundation/contracts/fixtures/agent-runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Input     SubmitInput `json:"input"`
		Task      Task        `json:"task"`
		Run       Run         `json:"run"`
		Call      Call        `json:"call"`
		Event     Event       `json:"event"`
		Info      RuntimeInfo `json:"info"`
		Failure   Failure     `json:"failure"`
		EmptyPage Page[Run]   `json:"emptyPage"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("Go DTO 与共享 fixture 不匹配：%v", err)
	}
	encoded, err := shared.MarshalJSON(fixture)
	if err != nil {
		t.Fatal(err)
	}
	var original, roundTrip any
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, roundTrip) {
		t.Fatalf("Go JSON 往返改变了跨端协议：%s", encoded)
	}
	if fixture.Run.LastSeq != "9007199254740993" || fixture.Event.Seq != fixture.Run.LastSeq || fixture.Event.StepIndex == nil || *fixture.Event.StepIndex != 0 {
		t.Fatal("字符串序号或第零步在传输中丢失")
	}
	if fixture.Run.Limits != DefaultLimits() {
		t.Fatal("共享 fixture 的限制与默认配置不一致")
	}

	raw, err = os.ReadFile("../../../../../packages/foundation/contracts/fixtures/agent-session.json")
	if err != nil {
		t.Fatal(err)
	}
	var agentFixture struct {
		CreateSession CreateSessionInput `json:"createSession"`
		SwitchModel   SwitchModelInput   `json:"switchModel"`
		Input         AgentInput         `json:"input"`
		Session       Session            `json:"session"`
		Task          Task               `json:"task"`
		Run           Run                `json:"run"`
		Call          Call               `json:"call"`
		ModelRequest  ModelRequestRecord `json:"modelRequest"`
		Memory        WorkingMemory      `json:"memory"`
		Message       Message            `json:"message"`
		Event         Event              `json:"event"`
		Info          RuntimeInfo        `json:"info"`
		EmptyPage     Page[Message]      `json:"emptyPage"`
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&agentFixture); err != nil {
		t.Fatalf("Agent Go DTO 与共享 fixture 不匹配：%v", err)
	}
	encoded, err = shared.MarshalJSON(agentFixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, roundTrip) {
		t.Fatalf("Agent Go JSON 往返改变了跨端协议：%s", encoded)
	}
	if agentFixture.Run.Limits != DefaultAgentLimits() {
		t.Fatal("Agent 共享 fixture 的限制与默认配置不一致")
	}
	if agentFixture.Memory.Coverage.EventSeq != "9007199254740993" || agentFixture.Message.Seq != agentFixture.Memory.Coverage.EventSeq || agentFixture.Run.HistorySeq != agentFixture.Message.Seq {
		t.Fatal("Agent 对话、历史或记忆序号丢失精度")
	}
	if agentFixture.Run.Model == nil || agentFixture.Run.Model.Credential != "" || !agentFixture.Run.Model.HasCredential || agentFixture.Run.Usage.CachedTokens != nil || agentFixture.ModelRequest.Response == nil || agentFixture.ModelRequest.Response.Usage.CachedTokens != nil {
		t.Fatal("Agent 公开模型泄露凭据或把未知缓存用量改成零")
	}
}
