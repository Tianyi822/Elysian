package harness

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func tokenTestManager(t *testing.T) *Manager {
	t.Helper()
	m, _, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("ok"), nil
	}, nil)
	return m
}

func tokenTestProfile(t *testing.T, m *Manager, provider, baseURL, modelID string) model.Profile {
	t.Helper()
	credential := "token-test-credential"
	profile, err := m.deps.Profiles.Create(model.Input{Provider: provider, APIFormat: model.FormatChatCompletions, BaseURL: baseURL, Model: modelID, ContextTokens: 128000, OutputTokens: 1024, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &credential})
	if err != nil {
		t.Fatal(err)
	}
	return profile
}

func setTokenizerEndpoint(m *Manager, endpoint string) {
	m.tokenEstimates.mu.Lock()
	defer m.tokenEstimates.mu.Unlock()
	m.tokenEstimates.endpoint = func(model.Profile) (string, bool) { return endpoint, true }
}

func setTokenizerTimeout(m *Manager, timeout time.Duration) {
	m.tokenEstimates.mu.Lock()
	defer m.tokenEstimates.mu.Unlock()
	m.tokenEstimates.timeout = timeout
}

// 既有字节基线保持不变，token 估算只改单位，不改变图片与结构开销的保守口径。
func TestEstimateRequestBytesAndTokenUnits(t *testing.T) {
	request := model.Request{MaxTokens: 128, Messages: []model.Message{{Role: "system", Content: "系统"}, {Role: "user", Content: "看图"}}}
	bytes, images := requestEstimateParts(request)
	if images != 0 || bytes != estimateRequestBytes(request) {
		t.Fatalf("字节基线拆分错误：bytes=%d images=%d", bytes, images)
	}
	if got, want := estimateRequestTokens(request), int(math.Ceil(float64(bytes)*defaultTokenRatio)); got != want {
		t.Fatalf("默认比例估算=%d，期望 %d", got, want)
	}
	request.EstimateRatio = 0.25
	if got, want := estimateRequestTokens(request), int(math.Ceil(float64(bytes)*0.25)); got != want {
		t.Fatalf("校准比例估算=%d，期望 %d", got, want)
	}
	// 比例被 clamp 到 [0.2, 1]：异常偏小的比例不会把估算压到下限以下，偏大也不会超过字节基线。
	request.EstimateRatio = 0.01
	if got, want := estimateRequestTokens(request), int(math.Ceil(float64(bytes)*minTokenRatio)); got != want {
		t.Fatalf("比例下限失效：got=%d want=%d", got, want)
	}
	request.EstimateRatio = 3
	if got := estimateRequestTokens(request); got != bytes {
		t.Fatalf("比例上限失效：got=%d want=%d", got, bytes)
	}
}

// 官方 prompt_tokens 反推的比例取中位数并上浮安全余量，异常样本与单次抖动被有界抑制。
func TestTokenRatioCalibrationBounded(t *testing.T) {
	profile := model.Profile{Provider: model.ProviderDeepSeek, APIFormat: model.FormatChatCompletions, Model: "deepseek-chat", BaseURL: "https://api.deepseek.com"}
	m := &Manager{}
	if got := m.tokenRatio(&profile); got != defaultTokenRatio {
		t.Fatalf("无样本时未使用保守默认比例：%v", got)
	}
	m.notePromptUsage(&profile, 4000, 1000)
	m.notePromptUsage(&profile, 4000, 1000)
	want := 0.25 * ratioSafetyPercent / 100
	if got := m.tokenRatio(&profile); math.Abs(got-want) > 1e-9 {
		t.Fatalf("中位数校准=%v，期望 %v", got, want)
	}
	// 单次异常（比例过小／过大／非正）被丢弃，不改变已有比例。
	m.notePromptUsage(&profile, 4000, 4)
	m.notePromptUsage(&profile, 4000, 8000)
	m.notePromptUsage(&profile, 4000, 0)
	m.notePromptUsage(&profile, -1, 100)
	if got := m.tokenRatio(&profile); math.Abs(got-want) > 1e-9 {
		t.Fatalf("异常样本污染校准：%v", got)
	}
	// 中位数抑制单次异常：三个样本中的离群值不改变结论。
	m.notePromptUsage(&profile, 4000, 600)
	if got := m.tokenRatio(&profile); math.Abs(got-want) > 1e-9 {
		t.Fatalf("离群样本改变了中位数：%v", got)
	}
	// 有界：低比例被 clamp 到下限，高比例被 clamp 到字节基线（1）。
	low := model.Profile{Provider: model.ProviderDeepSeek, Model: "low", BaseURL: "low"}
	m.notePromptUsage(&low, 10000, 1000)
	if got := m.tokenRatio(&low); got != minTokenRatio {
		t.Fatalf("低比例未 clamp：%v", got)
	}
	high := model.Profile{Provider: model.ProviderDeepSeek, Model: "high", BaseURL: "high"}
	m.notePromptUsage(&high, 10000, 9900)
	if got := m.tokenRatio(&high); got != 1 {
		t.Fatalf("高比例未 clamp：%v", got)
	}
}

func tokenizerFixtureRequest() model.Request {
	return model.Request{Messages: []model.Message{
		{Role: "system", Content: "系统"},
		{Role: "user", Content: "用户问题", Images: []model.ImagePart{{MimeType: "image/png", Data: []byte("ignored-image-bytes")}}},
		{Role: "assistant", Content: "先查", ToolCalls: []model.ToolCall{{ID: "call-1", Name: "host_usage", Arguments: json.RawMessage(`{"path":"/"}`)}}},
		{Role: "tool", ToolCallID: "call-1", Content: `{"result":"ok"}`},
	}, Tools: []model.Tool{{Name: "host_usage", Description: "查看主机占用", Parameters: json.RawMessage(`{"type":"object","properties":{}}`)}}}
}

// 智谱官方分词器：成功时使用官方 prompt_tokens，并补回图片与 tool_calls 的本地结构开销；
// 请求体把 tool role / tool_calls 保守文本化，凭据走 Bearer 头，图片字节不发送。
func TestZhipuTokenizerOfficialCountAndCompensation(t *testing.T) {
	m := tokenTestManager(t)
	profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
	var mu sync.Mutex
	var bodies []map[string]any
	var auth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		bodies = append(bodies, body)
		auth = r.Header.Get("Authorization")
		mu.Unlock()
		_, _ = w.Write([]byte(`{"id":"x","usage":{"prompt_tokens":1000,"total_tokens":1000}}`))
	}))
	defer server.Close()
	setTokenizerEndpoint(m, server.URL)

	execution := &agentExecution{manager: m, run: Run{Model: &profile}}
	got := execution.estimatePromptTokens(context.Background(), tokenizerFixtureRequest())
	if got != 1100+contextImageTokens+toolCallTokenCompensation {
		t.Fatalf("官方计数补偿错误：%d", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("官方分词器调用次数=%d", len(bodies))
	}
	if auth != "Bearer token-test-credential" {
		t.Fatalf("未使用固定凭据鉴权：%q", auth)
	}
	if bodies[0]["model"] != "glm-5.3" {
		t.Fatalf("模型标识错误：%v", bodies[0]["model"])
	}
	messages, _ := bodies[0]["messages"].([]any)
	if len(messages) != 4 {
		t.Fatalf("消息数量错误：%v", messages)
	}
	assistant, _ := messages[2].(map[string]any)
	if assistant["role"] != "assistant" || !strings.Contains(assistant["content"].(string), "[工具调用]") {
		t.Fatalf("tool_calls 未保守文本化：%v", assistant)
	}
	result, _ := messages[3].(map[string]any)
	if result["role"] != "user" || !strings.Contains(result["content"].(string), "[工具结果]") {
		t.Fatalf("tool role 未转换为用户文本：%v", result)
	}
	if strings.Contains(string(mustJSON(t, bodies[0])), "ignored-image-bytes") {
		t.Fatal("图片字节被发送到分词器")
	}
	tools, _ := bodies[0]["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("工具定义未传入：%v", bodies[0]["tools"])
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// 同一请求命中缓存只发一次；429 等瞬时失败静默回退，连续失败后本次运行不再尝试。
func TestZhipuTokenizerCacheAndTransientFallback(t *testing.T) {
	request := tokenizerFixtureRequest()
	t.Run("cache", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":700}}`))
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		first := execution.estimatePromptTokens(context.Background(), request)
		second := execution.estimatePromptTokens(context.Background(), request)
		if first != second || calls.Load() != 1 {
			t.Fatalf("缓存未生效：first=%d second=%d calls=%d", first, second, calls.Load())
		}
	})
	t.Run("rate limited", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusTooManyRequests)
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		if got := execution.estimatePromptTokens(context.Background(), request); got != estimateRequestTokens(request) {
			t.Fatalf("429 未回退本地估算：%d", got)
		}
		if execution.tokenizerFailures != 1 {
			t.Fatalf("失败计数错误：%d", execution.tokenizerFailures)
		}
		execution.estimatePromptTokens(context.Background(), request)
		execution.estimatePromptTokens(context.Background(), request)
		if calls.Load() != 2 {
			t.Fatalf("连续失败后仍在尝试官方分词器：%d", calls.Load())
		}
	})
	t.Run("payload rejected not remembered", func(t *testing.T) {
		// 413/422 可能是本次请求体过大或参数问题，不能永久关闭该配置的官方分词器。
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusRequestEntityTooLarge)
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		execution.estimatePromptTokens(context.Background(), request)
		execution.estimatePromptTokens(context.Background(), request)
		if calls.Load() != 2 || execution.tokenizerFailures != 2 {
			t.Fatalf("413 被当成永久拒绝或未计失败：calls=%d failures=%d", calls.Load(), execution.tokenizerFailures)
		}
		if m.tokenEstimates.isUnsupported(tokenizerSupportKey(&profile)) {
			t.Fatal("413 不应记忆为当前配置不支持官方分词器")
		}
	})
	t.Run("bad request in enum not remembered", func(t *testing.T) {
		// 文档枚举内模型的 400 可能是本次请求参数问题，不能永久关闭官方分词器。
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusBadRequest)
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		execution.estimatePromptTokens(context.Background(), request)
		execution.estimatePromptTokens(context.Background(), request)
		if calls.Load() != 2 || m.tokenEstimates.isUnsupported(tokenizerSupportKey(&profile)) {
			t.Fatalf("枚举内模型的 400 被记忆为不支持：calls=%d", calls.Load())
		}
	})
	t.Run("unknown model rejected", func(t *testing.T) {
		// 不在官方分词器枚举内的模型（如 GLM-5.3-Flash）被 400 拒绝后记忆到当前修订，
		// 避免每个 Run 重复发出两次无效计数请求。
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusBadRequest)
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		execution.estimatePromptTokens(context.Background(), request)
		execution.estimatePromptTokens(context.Background(), request)
		if calls.Load() != 1 || !m.tokenEstimates.isUnsupported(tokenizerSupportKey(&profile)) {
			t.Fatalf("枚举外模型 400 未记忆：calls=%d", calls.Load())
		}
	})
	t.Run("success resets failures", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) == 1 {
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":700}}`))
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		execution.estimatePromptTokens(context.Background(), request)
		if execution.tokenizerFailures != 1 {
			t.Fatalf("瞬时失败未计数：%d", execution.tokenizerFailures)
		}
		// 不同请求内容避免命中缓存；成功后连续失败计数清零，下一次仍会优先官方计数。
		second := model.Request{Messages: []model.Message{{Role: "system", Content: "系统"}, {Role: "user", Content: "第二次请求"}}}
		got := execution.estimatePromptTokens(context.Background(), second)
		if got != 770 || execution.tokenizerFailures != 0 {
			t.Fatalf("成功未使用官方计数或未清零失败：got=%d failures=%d", got, execution.tokenizerFailures)
		}
		third := model.Request{Messages: []model.Message{{Role: "system", Content: "系统"}, {Role: "user", Content: "第三次请求"}}}
		if got := execution.estimatePromptTokens(context.Background(), third); got != 770 {
			t.Fatalf("成功后未恢复官方分词器调用：got=%d", got)
		}
		if calls.Load() != 3 {
			t.Fatalf("成功重置后调用次数错误：%d", calls.Load())
		}
	})
	t.Run("timeout", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3")
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(80 * time.Millisecond)
			_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":700}}`))
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		setTokenizerTimeout(m, 10*time.Millisecond)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		if got := execution.estimatePromptTokens(context.Background(), request); got != estimateRequestTokens(request) {
			t.Fatalf("超时未回退本地估算：%d", got)
		}
	})
}

// 明确拒绝（404）记忆到当前配置修订，后续请求不再发；非智谱供应商与自定义 host 一律不发送。
func TestTokenizerSkipsRejectedModelAndForeignHosts(t *testing.T) {
	request := tokenizerFixtureRequest()
	t.Run("rejected", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderZhipu, "https://open.bigmodel.cn/api/coding/paas/v4", "glm-5.3-flash")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusNotFound)
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		execution.estimatePromptTokens(context.Background(), request)
		execution.estimatePromptTokens(context.Background(), request)
		if calls.Load() != 1 {
			t.Fatalf("明确拒绝后仍重复请求：%d", calls.Load())
		}
	})
	t.Run("foreign provider", func(t *testing.T) {
		m := tokenTestManager(t)
		profile := tokenTestProfile(t, m, model.ProviderOpenAICompatible, "https://example.com/v1", "foreign-model")
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			_, _ = w.Write([]byte(`{"usage":{"prompt_tokens":1}}`))
		}))
		defer server.Close()
		setTokenizerEndpoint(m, server.URL)
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		if got := execution.estimatePromptTokens(context.Background(), request); got != estimateRequestTokens(request) {
			t.Fatalf("非官方供应商未走本地估算：%d", got)
		}
		if calls.Load() != 0 {
			t.Fatalf("非官方供应商仍请求分词器：%d", calls.Load())
		}
	})
	t.Run("foreign host", func(t *testing.T) {
		m := tokenTestManager(t)
		var calls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
		}))
		defer server.Close()
		profile := tokenTestProfile(t, m, model.ProviderZhipu, server.URL+"/api/coding/paas/v4", "glm-5.3")
		execution := &agentExecution{manager: m, run: Run{Model: &profile}}
		if got := execution.estimatePromptTokens(context.Background(), request); got != estimateRequestTokens(request) {
			t.Fatalf("未知名 host 未走本地估算：%d", got)
		}
		if calls.Load() != 0 {
			t.Fatalf("向未知名 host 发送了凭据：%d", calls.Load())
		}
	})
}

// DeepSeek 没有计数接口：没有官方计数时使用已确认 usage 校准后的比例，单位仍是 token。
func TestEstimatePromptTokensUsesCalibratedRatio(t *testing.T) {
	m := tokenTestManager(t)
	profile := tokenTestProfile(t, m, model.ProviderDeepSeek, "https://api.deepseek.com", "deepseek-chat")
	m.notePromptUsage(&profile, 4000, 1000)
	m.notePromptUsage(&profile, 4000, 1000)
	request := model.Request{Messages: []model.Message{{Role: "system", Content: "系统"}, {Role: "user", Content: strings.Repeat("x", 4000)}}}
	payload, images := requestEstimateParts(request)
	want := int(math.Ceil(float64(payload)*m.tokenRatio(&profile))) + images
	execution := &agentExecution{manager: m, run: Run{Model: &profile}}
	if got := execution.estimatePromptTokens(context.Background(), request); got != want {
		t.Fatalf("校准比例未生效：got=%d want=%d", got, want)
	}
}

// 单位统一后，压缩阈值按真实 token 的 80% 触发，不再被字节高估提前触发。
func TestContextPressureUsesTokenUnits(t *testing.T) {
	request := model.Request{Messages: []model.Message{{Role: "user", Content: strings.Repeat("x", 8000)}}, MaxTokens: 100, EstimateRatio: 0.25}
	payload, _ := requestEstimateParts(request)
	estimate := estimateRequestTokens(request)
	if want := int(math.Ceil(float64(payload) * 0.25)); estimate != want {
		t.Fatalf("token 估算=%d，期望 %d", estimate, want)
	}
	pressure := estimate + request.MaxTokens
	if payload <= pressure {
		t.Fatalf("fixture 字节基线未显著高于 token 估算：payload=%d pressure=%d", payload, pressure)
	}
	boundary := pressure * 100 / autoCompactPercent
	if boundary < 1 {
		t.Fatalf("fixture 容量过小：%d", boundary)
	}
	a := &agentExecution{run: Run{Model: &model.Profile{ContextTokens: boundary}, Limits: Limits{TokenBudget: boundary * 10}}}
	if !a.contextPressure(request) {
		t.Fatal("达到 80% 阈值未触发压缩")
	}
	a.run.Model.ContextTokens = boundary + 1
	if a.contextPressure(request) {
		t.Fatal("未到 80% 阈值却触发压缩")
	}
}

// 小模型准入用 token 估算：字节基线超过模型容量时，真实 token 仍能装下就应放行。
func TestFitsUsesTokenUnitsForSmallModel(t *testing.T) {
	request := model.Request{Messages: []model.Message{{Role: "user", Content: strings.Repeat("x", 4000)}}, MaxTokens: 64, EstimateRatio: 0.25}
	estimate := estimateRequestTokens(request)
	contextTokens := estimate + request.MaxTokens
	a := &agentExecution{run: Run{Model: &model.Profile{ContextTokens: contextTokens}}}
	if !a.fits(request) {
		t.Fatal("token 估算可容纳的请求被判超容量")
	}
	if estimateRequestBytes(request) <= contextTokens {
		t.Fatalf("fixture 字节基线未超过容量：bytes=%d context=%d", estimateRequestBytes(request), contextTokens)
	}
	a.run.Model.ContextTokens = contextTokens - 1
	if a.fits(request) {
		t.Fatal("超过 token 容量仍被放行")
	}
}

// 已确认响应的 prompt_tokens 为官方实测锚点：同一 Run 的下一次推理使用校准后的 token 估算。
func TestOfficialUsageAnchorCalibratesNextRequest(t *testing.T) {
	var initialInferences atomic.Int32
	var mu sync.Mutex
	var firstPayload, firstPrompt, secondPayload int
	client := func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		n := initialInferences.Add(1)
		payload, images := requestEstimateParts(request)
		if images != 0 {
			t.Errorf("测试请求不应带图片：%d", images)
		}
		if n == 1 {
			prompt := payload * 3 / 10
			mu.Lock()
			firstPayload, firstPrompt = payload, prompt
			mu.Unlock()
			return usageReply(toolReply("docker_images_list"), prompt, 10), nil
		}
		mu.Lock()
		secondPayload = payload
		mu.Unlock()
		return finalReply("完成"), nil
	}
	m, session, invoker := agentManager(t, client, nil)
	invoker.execute = func(context.Context, string) (any, error) { return "ok", nil }
	run := submitAgentTest(t, m, session, "usage-anchor", "读取镜像后给出结论")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	inferences := []ModelRequestRecord{}
	for _, record := range records.Items {
		if record.Purpose == "inference" {
			inferences = append(inferences, record)
		}
	}
	if len(inferences) != 2 || firstPayload == 0 || secondPayload == 0 || secondPayload <= firstPayload {
		t.Fatalf("样本不足：records=%d first=%d second=%d", len(inferences), firstPayload, secondPayload)
	}
	if want := int(math.Ceil(float64(firstPayload) * defaultTokenRatio)); inferences[0].EstimatedTokens != want {
		t.Fatalf("首轮未使用保守默认比例：got=%d want=%d", inferences[0].EstimatedTokens, want)
	}
	ratio := float64(firstPrompt) / float64(firstPayload) * ratioSafetyPercent / 100
	if want := int(math.Ceil(float64(secondPayload) * ratio)); inferences[1].EstimatedTokens != want {
		t.Fatalf("次轮未使用官方锚点校准：got=%d want=%d ratio=%v", inferences[1].EstimatedTokens, want, ratio)
	}
	if inferences[1].EstimatedTokens >= secondPayload {
		t.Fatalf("校准估算未低于字节基线：estimate=%d bytes=%d", inferences[1].EstimatedTokens, secondPayload)
	}
}
