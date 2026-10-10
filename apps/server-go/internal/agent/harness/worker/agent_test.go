package worker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type testAgentBroker struct {
	model func(context.Context) (ModelResponse, error)
	tool  func(context.Context, string, int, string, string, json.RawMessage) error
	final func(context.Context, string) error
}

func (b testAgentBroker) NextModel(ctx context.Context) (ModelResponse, error) { return b.model(ctx) }
func (b testAgentBroker) ExecuteAgent(ctx context.Context, response string, index int, call, name string, args json.RawMessage) error {
	return b.tool(ctx, response, index, call, name, args)
}
func (b testAgentBroker) Finalize(ctx context.Context, response string) error {
	return b.final(ctx, response)
}

func finalAgentBroker() testAgentBroker {
	return testAgentBroker{model: func(context.Context) (ModelResponse, error) {
		return ModelResponse{ID: "final-response", Final: true}, nil
	}, final: func(context.Context, string) error { return nil }}
}

func TestAgentDriverSerialLoopKeepsToolOutcomesInParent(t *testing.T) {
	var operations []string
	turn := 0
	broker := testAgentBroker{
		model: func(context.Context) (ModelResponse, error) {
			turn++
			operations = append(operations, fmt.Sprintf("model%d", turn))
			if turn == 1 {
				return ModelResponse{ID: "response1", ToolCalls: []AgentToolCall{{ID: "call1", Name: "read", Args: json.RawMessage(`{"number":9007199254740993}`)}, {ID: "call2", Name: "read"}}}, nil
			}
			return ModelResponse{ID: "response2", Final: true}, nil
		},
		tool: func(_ context.Context, response string, index int, call, name string, args json.RawMessage) error {
			if response != "response1" || call != fmt.Sprintf("call%d", index+1) || name != "read" {
				t.Errorf("工具身份错配：%s %d %s %s", response, index, call, name)
			}
			if index == 0 && !strings.Contains(string(args), "9007199254740993") {
				t.Error("大整数参数丢失精度")
			}
			operations = append(operations, call)
			// 父侧已经持久化业务失败也返回 nil，让模型能读取结果并继续。
			return nil
		},
		final: func(_ context.Context, response string) error {
			operations = append(operations, "final:"+response)
			return nil
		},
	}
	if err := (agentDriver{}).Run(context.Background(), broker); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(operations, ","); got != "model1,call1,call2,model2,final:response2" {
		t.Fatal(got)
	}
}

func TestAgentProcessRunsThroughRealPipesAndWaitsForFinalize(t *testing.T) {
	p := startTestWorker(t, "normal")
	var capability AgentProcess = p
	finalEntered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	var toolCount atomic.Int32
	var turns atomic.Int32
	broker := testAgentBroker{
		model: func(context.Context) (ModelResponse, error) {
			if turns.Add(1) == 1 {
				return ModelResponse{ID: "response1", ToolCalls: []AgentToolCall{{ID: "call1", Name: "read"}, {ID: "call2", Name: "read"}}}, nil
			}
			return ModelResponse{ID: "response2", Final: true}, nil
		},
		tool: func(_ context.Context, response string, index int, call, name string, args json.RawMessage) error {
			if toolCount.Add(1) != int32(index+1) || response != "response1" || call != fmt.Sprintf("call%d", index+1) || name != "read" || string(args) != "{}" {
				return errors.New("调用身份或串行顺序错误")
			}
			return nil
		},
		final: func(ctx context.Context, response string) error {
			if response != "response2" {
				return errors.New("最终响应身份错误")
			}
			close(finalEntered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	done := make(chan error, 1)
	go func() { done <- capability.RunAgent(context.Background(), "agent-run", broker) }()
	select {
	case <-finalEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("未进入父侧整理")
	}
	select {
	case err := <-done:
		t.Fatalf("整理落盘前提前完成：%v", err)
	default:
	}
	if err := p.Run(context.Background(), "parallel-batch", nil, noTool); !errors.Is(err, ErrBusy) {
		t.Fatalf("Agent 与 batch 未共用执行槽：%v", err)
	}
	release <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if toolCount.Load() != 2 || turns.Load() != 2 {
		t.Fatalf("调用数量错误：%d %d", toolCount.Load(), turns.Load())
	}
	if err := p.Run(context.Background(), "following-batch", nil, noTool); err != nil {
		t.Fatal(err)
	}
	if err := p.RunAgent(context.Background(), "following-agent", finalAgentBroker()); err != nil {
		t.Fatal(err)
	}
}

func TestAgentBrokerFailurePreservesCauseAndReusesWorker(t *testing.T) {
	for _, operation := range []string{"model", "tool", "finalize", "panic"} {
		t.Run(operation, func(t *testing.T) {
			p := startTestWorker(t, "normal")
			want := errors.New("父侧持久化失败 secret-marker")
			broker := finalAgentBroker()
			switch operation {
			case "model":
				broker.model = func(context.Context) (ModelResponse, error) { return ModelResponse{}, want }
			case "tool":
				broker.model = func(context.Context) (ModelResponse, error) {
					return ModelResponse{ID: "response", ToolCalls: []AgentToolCall{{ID: "call", Name: "read"}}}, nil
				}
				broker.tool = func(context.Context, string, int, string, string, json.RawMessage) error { return want }
			case "finalize":
				broker.final = func(context.Context, string) error { return want }
			case "panic":
				broker.model = func(context.Context) (ModelResponse, error) { panic("secret-marker") }
			}
			err := p.RunAgent(context.Background(), "failure-run", broker)
			if operation != "panic" && !errors.Is(err, want) {
				t.Fatalf("父侧错误原因丢失：%v", err)
			}
			if operation == "panic" && (err == nil || strings.Contains(err.Error(), "secret-marker")) {
				t.Fatalf("异常信息未隔离：%v", err)
			}
			var interrupted *InterruptedError
			if errors.As(err, &interrupted) {
				t.Fatalf("父侧操作失败不应破坏 Worker：%v", err)
			}
			p.stderr.mu.Lock()
			if strings.Contains(string(p.stderr.data), "secret-marker") {
				t.Error("父侧错误进入子进程诊断")
			}
			p.stderr.mu.Unlock()
			if err := p.RunAgent(context.Background(), "after-failure", finalAgentBroker()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAgentRejectsInvalidOrRepeatedModelIdentities(t *testing.T) {
	for _, mode := range []string{"empty", "both", "duplicate-call", "duplicate-response", "reused-call", "bad-args", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			p := startTestWorker(t, "normal")
			turn, calls := 0, 0
			broker := testAgentBroker{model: func(context.Context) (ModelResponse, error) {
				turn++
				response := ModelResponse{ID: fmt.Sprintf("response%d", turn), ToolCalls: []AgentToolCall{{ID: fmt.Sprintf("call%d", turn), Name: "read"}}}
				switch mode {
				case "empty":
					response.ToolCalls = nil
				case "both":
					response.Final = true
				case "duplicate-call":
					response.ToolCalls = append(response.ToolCalls, response.ToolCalls[0])
				case "duplicate-response":
					response.ID = "response1"
				case "reused-call":
					response.ToolCalls[0].ID = "call1"
				case "bad-args":
					response.ToolCalls[0].Args = json.RawMessage(`[]`)
				case "oversized":
					response.ToolCalls[0].Args = json.RawMessage(`{"large":"` + strings.Repeat("x", MaxFrameBytes) + `"}`)
				}
				return response, nil
			}, tool: func(context.Context, string, int, string, string, json.RawMessage) error { calls++; return nil }, final: func(context.Context, string) error { t.Error("非法响应不能整理"); return nil }}
			if err := p.RunAgent(context.Background(), "invalid-response", broker); err == nil {
				t.Fatal("接受了非法模型响应")
			}
			wantCalls := 0
			if mode == "duplicate-response" || mode == "reused-call" {
				wantCalls = 1
			}
			if calls != wantCalls {
				t.Fatalf("非法响应触达了工具：%d", calls)
			}
			if err := p.RunAgent(context.Background(), "after-invalid", finalAgentBroker()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAgentCancellationWhileModelPendingAndWorkerReuse(t *testing.T) {
	p := startTestWorker(t, "normal")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	broker := finalAgentBroker()
	broker.model = func(ctx context.Context) (ModelResponse, error) {
		close(entered)
		<-ctx.Done()
		return ModelResponse{}, ctx.Err()
	}
	done := make(chan error, 1)
	go func() { done <- p.RunAgent(ctx, "cancel-model", broker) }()
	<-entered
	if err := p.RunAgent(context.Background(), "other", finalAgentBroker()); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		var interrupted *InterruptedError
		if !errors.Is(err, context.Canceled) || errors.As(err, &interrupted) {
			t.Fatalf("协作取消错误：%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("模型等待未及时取消")
	}
	if err := p.RunAgent(context.Background(), "after-cancel", finalAgentBroker()); err != nil {
		t.Fatal(err)
	}
}

func TestAgentCancelsPendingToolAndFinalize(t *testing.T) {
	for _, operation := range []string{"tool", "finalize"} {
		t.Run(operation, func(t *testing.T) {
			p := startTestWorker(t, "normal")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			entered := make(chan struct{})
			wait := func(ctx context.Context) error { close(entered); <-ctx.Done(); return ctx.Err() }
			broker := finalAgentBroker()
			if operation == "tool" {
				broker.model = func(context.Context) (ModelResponse, error) {
					return ModelResponse{ID: "response", ToolCalls: []AgentToolCall{{ID: "call", Name: "wait"}}}, nil
				}
				broker.tool = func(ctx context.Context, _ string, _ int, _, _ string, _ json.RawMessage) error { return wait(ctx) }
			} else {
				broker.final = func(ctx context.Context, _ string) error { return wait(ctx) }
			}
			done := make(chan error, 1)
			go func() { done <- p.RunAgent(ctx, "cancel-operation", broker) }()
			<-entered
			cancel()
			select {
			case err := <-done:
				var interrupted *InterruptedError
				if !errors.Is(err, context.Canceled) || errors.As(err, &interrupted) {
					t.Fatalf("父侧操作没有协作取消：%v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("父侧操作取消未收尾")
			}
			if err := p.RunAgent(context.Background(), "after-cancel", finalAgentBroker()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAgentUnresponsiveParentOperationKillsAndReapsWorker(t *testing.T) {
	p := startTestWorker(t, "normal")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	broker := finalAgentBroker()
	broker.model = func(context.Context) (ModelResponse, error) {
		close(entered)
		<-release
		close(returned)
		return ModelResponse{ID: "late-response", Final: true}, nil
	}
	done := make(chan error, 1)
	go func() { done <- p.RunAgent(ctx, "unresponsive-parent", broker) }()
	<-entered
	cancel()
	select {
	case err := <-done:
		var interrupted *InterruptedError
		if !errors.As(err, &interrupted) || !errors.Is(err, context.Canceled) {
			t.Fatalf("未响应取消必须标记中断：%v", err)
		}
	case <-time.After(7 * time.Second):
		t.Fatal("未响应操作突破取消宽限")
	}
	select {
	case <-p.exited:
	default:
		t.Fatal("返回前未回收子进程")
	}
	release <- struct{}{}
	<-returned
}

func TestServeAgentRejectsMalformedResultsAndRepeatedResponse(t *testing.T) {
	hello := frame{Version: protocolVersion, Generation: "generation", Type: "hello"}
	start := frame{Version: protocolVersion, Generation: "generation", Type: "run/start", Driver: agentDriverName, DriverVersion: agentDriverVersion, RunID: "run", RequestID: "request"}
	first, second, third := 0, 1, 2
	result := frame{Version: protocolVersion, Generation: "generation", Type: "agent/result", RunID: "run", RequestID: "request", Operation: &first, ResponseID: "response", ToolCalls: []AgentToolCall{{ID: "call", Name: "read", Args: json.RawMessage(`{}`)}}}
	wrongOperation := result
	wrongOperation.Operation = &second
	wrongRun := result
	wrongRun.RunID = "other"
	errorWithInstructions := result
	errorWithInstructions.Error = "失败"
	ack := frame{Version: protocolVersion, Generation: "generation", Type: "agent/result", RunID: "run", RequestID: "request", Operation: &second}
	repeated := result
	repeated.Operation = &third
	for _, messages := range [][]frame{
		{hello, start, wrongOperation}, {hello, start, wrongRun}, {hello, start, errorWithInstructions}, {hello, start, result, ack, repeated},
	} {
		var input, output bytes.Buffer
		for _, f := range messages {
			if err := writeFrame(&input, f); err != nil {
				t.Fatal(err)
			}
		}
		if err := Serve(&input, &output, nil); err == nil {
			t.Fatal("子进程接受了非法 Agent 操作结果")
		}
	}
}

func TestAgentSubprocess(t *testing.T) {
	mode := os.Getenv("ELYSIAN_AGENT_WORKER_TEST_MODE")
	if mode == "" {
		return
	}
	if err := maliciousAgentWorker(mode); err != nil {
		os.Exit(7)
	}
	os.Exit(0)
}

func maliciousAgentWorker(mode string) error {
	reader := bufio.NewReader(os.Stdin)
	hello, err := readFrame(reader)
	if err != nil {
		return err
	}
	base := frame{Version: protocolVersion, Generation: hello.Generation, Type: "ready"}
	if err = writeFrame(os.Stdout, base); err != nil {
		return err
	}
	start, err := readFrame(reader)
	if err != nil {
		return err
	}
	base.RunID, base.RequestID = start.RunID, start.RequestID
	op := 0
	request := base
	request.Type, request.Operation = "agent/model", &op
	if mode == "early-success" {
		request.Type, request.Operation, request.Status = "run/finished", nil, "succeeded"
	}
	if mode == "bad-operation" {
		op = 1
	}
	if err = writeFrame(os.Stdout, request); err != nil {
		return err
	}
	if mode == "duplicate-model" {
		if err = writeFrame(os.Stdout, request); err != nil {
			return err
		}
	}
	result, err := readFrame(reader)
	if err != nil || result.Type != "agent/result" {
		return err
	}
	if mode == "ignore-cancel" {
		for {
			if _, err = readFrame(reader); err != nil {
				return err
			}
		}
	}
	if len(result.ToolCalls) == 0 {
		return nil
	}
	op, index := 1, 0
	call := result.ToolCalls[0]
	request = base
	request.Type, request.Operation, request.Index = "agent/tool", &op, &index
	request.ResponseID, request.CallID, request.Tool, request.Args = result.ResponseID, call.ID, call.Name, call.Args
	switch mode {
	case "bad-response":
		request.ResponseID = "different-response"
	case "bad-call":
		request.CallID = "different-call"
	case "bad-args":
		request.Args = json.RawMessage(`{"changed":true}`)
	case "bad-index":
		index = 1
	case "skip-tools":
		request = base
		request.Type, request.Operation = "agent/model", &op
	case "early-finalize":
		request = base
		request.Type, request.Operation, request.ResponseID = "agent/finalize", &op, result.ResponseID
	}
	if err = writeFrame(os.Stdout, request); err != nil {
		return err
	}
	if mode == "duplicate-tool" {
		if err = writeFrame(os.Stdout, request); err != nil {
			return err
		}
	}
	for {
		if _, err = readFrame(reader); err != nil {
			return nil
		}
	}
}

func TestAgentProtocolCannotEscapePersistedModelResponse(t *testing.T) {
	for _, mode := range []string{"early-success", "bad-operation", "duplicate-model", "bad-response", "bad-call", "bad-args", "bad-index", "skip-tools", "early-finalize", "duplicate-tool"} {
		t.Run(mode, func(t *testing.T) {
			child, err := Spawn(context.Background(), Options{Path: os.Args[0], Args: []string{"-test.run=^TestAgentSubprocess$"}, Env: []string{"ELYSIAN_AGENT_WORKER_TEST_MODE=" + mode}})
			if err != nil {
				t.Fatal(err)
			}
			defer child.Close(context.Background())
			var calls, models, finals atomic.Int32
			broker := testAgentBroker{model: func(context.Context) (ModelResponse, error) {
				models.Add(1)
				return ModelResponse{ID: "response", ToolCalls: []AgentToolCall{{ID: "call", Name: "read"}}}, nil
			}, tool: func(context.Context, string, int, string, string, json.RawMessage) error { calls.Add(1); return nil }, final: func(context.Context, string) error { finals.Add(1); return nil }}
			err = child.(AgentProcess).RunAgent(context.Background(), "guarded-agent", broker)
			var interrupted *InterruptedError
			if !errors.As(err, &interrupted) {
				t.Fatalf("非法 Worker 未中断：%v", err)
			}
			maxCalls := int32(0)
			if mode == "duplicate-tool" {
				maxCalls = 1
			}
			if calls.Load() > maxCalls || models.Load() > 1 || finals.Load() != 0 {
				t.Fatalf("越权触达父侧：model=%d tool=%d final=%d", models.Load(), calls.Load(), finals.Load())
			}
		})
	}
}
