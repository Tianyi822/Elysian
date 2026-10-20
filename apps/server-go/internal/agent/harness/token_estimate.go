package harness

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/agent/harness/model"
)

// 本文件统一 Agent 的 token 估算单位：模型容量、Run 预算、压缩阈值与请求记录都按 token 记账。
// 现有 JSON 字节估算保留为内部基线 estimateRequestBytes；token 估算 = 字节 × 每模型比例 + 图片补偿。
// 比例来源依次为：智谱官方分词器 HTTP API 实测（仅 zhipu 且已知官方 host）、已确认响应
// prompt_tokens 与同一请求字节估算反推的校准比例（manager 内存态，有界、确定性、重启丢弃）、
// 保守默认比例。官方能力调研结论见简报：DeepSeek 没有 token 计数 HTTP 接口，只有响应 usage
// 实测与需 Python 的离线 tokenizer，因此两者都只走 usage 锚点校准；智谱有官方在线分词器，
// 所以额外走 HTTP 实测。任何官方路径失败都静默回退本地估算，绝不阻断推理。

const (
	// defaultTokenRatio 是没有任何官方数据时的字节→token 保守比例。常见中英文文本每字节约
	// 0.2–0.35 token，0.5 留出接近一倍余量；符号密集的极端内容可能接近 1，仍由 clamp 上限兜底。
	defaultTokenRatio = 0.5
	// minTokenRatio 是校准比例下限：中文 UTF-8 文本实测约每字节 0.2 token，再低视为异常样本。
	minTokenRatio = 0.2
	// ratioSafetyPercent 给官方反推比例加安全余量，覆盖分词器与服务端 prompt 模板差异。
	ratioSafetyPercent = 115
	// officialSafetyPercent 给智谱分词器实测值加安全余量。
	officialSafetyPercent = 110
	// tokenRatioSampleCount 是每模型保留的最近反推样本数，取中位数抑制单次异常。
	tokenRatioSampleCount = 8
	// 反推样本接受区间：字节估算理论上不小于 token 数，落在区间外的样本视为异常丢弃。
	minObservedRatio = 0.05
	maxObservedRatio = 1.0

	tokenizerTimeout          = 2500 * time.Millisecond
	tokenizerCacheLimit       = 16
	tokenizerMaxTools         = 128
	tokenizerMaxResponse      = 64 << 10
	tokenizerFailureLimit     = 2
	toolCallTokenCompensation = 16
)

// tokenizerGate 串行化官方分词器调用：供应商按账户并发限流，计数请求不应抢占模型请求的配额，
// 也不应同时打出多份大 prompt。
var tokenizerGate = make(chan struct{}, 1)

// tokenizerHTTP 不跟随重定向，避免把凭据带去其他地址；总时限由每次调用的 context 控制。
var tokenizerHTTP = &http.Client{
	Timeout: tokenizerTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// tokenRatioSamples 保存一个模型配置最近的官方反推比例样本。
type tokenRatioSamples struct {
	values []float64
}

// tokenEstimateStore 是 Manager 持有的估算内存态：每模型反推比例、官方分词器结果缓存、
// 明确不支持的模型配置；重启后全部丢弃，不影响容量准入的保守回退。
type tokenEstimateStore struct {
	mu          sync.Mutex
	ratios      map[string]*tokenRatioSamples
	tokenizer   map[[32]byte]int
	cacheOrder  [][32]byte
	unsupported map[string]bool
	// endpoint／timeout／client 允许测试注入假分词器端点；生产路径使用默认推导与默认客户端。
	endpoint func(model.Profile) (string, bool)
	timeout  time.Duration
	client   *http.Client
}

// requestEstimateParts 拆出与图片无关的请求字节基线和图片补偿 token。
// 图片字节不进入 JSON（ImagePart 不序列化），图片按既有每张 1024 token 的保守口径单独补偿。
func requestEstimateParts(request model.Request) (payloadBytes, imageTokens int) {
	b, _ := json.Marshal(request)
	images := 0
	for _, message := range request.Messages {
		images += len(message.Images)
	}
	return len(b) + 256 + 128*len(request.Tools) + 64*len(request.Messages), images * contextImageTokens
}

// estimateRequestBytes 是既有 JSON 字节估算的基线口径，保留给测试与调试，不直接与容量比较。
// UTF-8 字节数加结构开销是与模型无关的保守上界；图片按每张 1024 token 计。
func estimateRequestBytes(request model.Request) int {
	payload, images := requestEstimateParts(request)
	return payload + images
}

func clampTokenRatio(ratio float64) float64 {
	if math.IsNaN(ratio) || ratio <= 0 {
		return defaultTokenRatio
	}
	if ratio < minTokenRatio {
		return minTokenRatio
	}
	if ratio > 1 {
		return 1
	}
	return ratio
}

func tokenCountFromParts(payloadBytes, imageTokens int, ratio float64) int {
	if payloadBytes < 0 {
		payloadBytes = 0
	}
	ratio = clampTokenRatio(ratio)
	return int(math.Ceil(float64(payloadBytes)*ratio)) + imageTokens
}

// estimateRequestTokens 是不发网络、可在装配循环里重复调用的 token 估算；比例由 buildContext
// 从 manager 校准状态写入 request.EstimateRatio，未写入时用保守默认比例。
func estimateRequestTokens(request model.Request) int {
	payload, images := requestEstimateParts(request)
	return tokenCountFromParts(payload, images, request.EstimateRatio)
}

// estimateRequest 保持既有调用点签名，语义已统一为 token 估算。
func estimateRequest(request model.Request) int {
	return estimateRequestTokens(request)
}

// tokenProfileKey 是校准比例的键：tokenizer 只由供应商、协议、模型与服务地址决定，
// 容量等配置修订不改变分词口径，因此键不包含 profile 修订号。
func tokenProfileKey(profile *model.Profile) string {
	if profile == nil {
		return ""
	}
	return profile.Provider + "|" + profile.APIFormat + "|" + profile.Model + "|" + strings.TrimRight(profile.BaseURL, "/")
}

// tokenizerSupportKey 在比例键上附加精确配置修订：官方端点拒绝通常与凭据/套餐有关，
// 用户更换凭据生成新修订后应重新尝试。
func tokenizerSupportKey(profile *model.Profile) string {
	if profile == nil {
		return ""
	}
	return tokenProfileKey(profile) + "#" + profile.ID + ":" + strconv.Itoa(profile.Revision)
}

func (s *tokenEstimateStore) recordRatio(key string, observed float64) {
	if key == "" || math.IsNaN(observed) || observed < minObservedRatio || observed > maxObservedRatio {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ratios == nil {
		s.ratios = map[string]*tokenRatioSamples{}
	}
	sample := s.ratios[key]
	if sample == nil {
		sample = &tokenRatioSamples{}
		s.ratios[key] = sample
	}
	sample.values = append(sample.values, observed)
	if len(sample.values) > tokenRatioSampleCount {
		sample.values = sample.values[len(sample.values)-tokenRatioSampleCount:]
	}
}

// ratio 取最近样本的中位数，再乘安全余量并 clamp；没有样本时返回保守默认比例。
func (s *tokenEstimateStore) ratio(key string) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	sample := s.ratios[key]
	if sample == nil || len(sample.values) == 0 {
		return defaultTokenRatio
	}
	sorted := append([]float64(nil), sample.values...)
	sort.Float64s(sorted)
	middle := len(sorted) / 2
	median := sorted[middle]
	if len(sorted)%2 == 0 {
		median = (sorted[middle-1] + sorted[middle]) / 2
	}
	return clampTokenRatio(median * ratioSafetyPercent / 100)
}

func (s *tokenEstimateStore) cachedOfficial(digest [32]byte) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count, ok := s.tokenizer[digest]
	return count, ok
}

// cacheOfficial 以有界 FIFO 缓存官方计数；相同请求（例如压缩阈值附近的多轮预检）不再重复请求。
func (s *tokenEstimateStore) cacheOfficial(digest [32]byte, count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokenizer == nil {
		s.tokenizer = map[[32]byte]int{}
	}
	if _, exists := s.tokenizer[digest]; exists {
		return
	}
	s.tokenizer[digest] = count
	s.cacheOrder = append(s.cacheOrder, digest)
	for len(s.cacheOrder) > tokenizerCacheLimit {
		oldest := s.cacheOrder[0]
		s.cacheOrder = s.cacheOrder[1:]
		delete(s.tokenizer, oldest)
	}
}

func (s *tokenEstimateStore) isUnsupported(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unsupported[key]
}

func (s *tokenEstimateStore) markUnsupported(key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unsupported == nil {
		s.unsupported = map[string]bool{}
	}
	s.unsupported[key] = true
}

func (s *tokenEstimateStore) endpointURL(profile model.Profile) (string, bool) {
	s.mu.Lock()
	endpoint := s.endpoint
	s.mu.Unlock()
	if endpoint != nil {
		return endpoint(profile)
	}
	return zhipuTokenizerEndpoint(profile)
}

func (s *tokenEstimateStore) callTimeout() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timeout > 0 {
		return s.timeout
	}
	return tokenizerTimeout
}

func (s *tokenEstimateStore) httpClient() *http.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		return s.client
	}
	return tokenizerHTTP
}

// zhipuTokenizerEndpoint 只在已知智谱官方 host 上推导标准 API 分词器地址：
// 面板预设的 Coding Plan 地址是 /api/coding/paas/v4，分词器固定走同 host 的 /api/paas/v4/tokenizer。
// 自定义网关不发送官方计数请求，避免把凭据交给未声明支持的地址。
func zhipuTokenizerEndpoint(profile model.Profile) (string, bool) {
	if profile.Provider != model.ProviderZhipu {
		return "", false
	}
	parsed, err := url.Parse(strings.TrimSpace(profile.BaseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "open.bigmodel.cn", "api.z.ai":
		return parsed.Scheme + "://" + parsed.Host + "/api/paas/v4/tokenizer", true
	}
	return "", false
}

// zhipuTokenizerModels 是官方分词器文档列出的模型标识（小写）。不在此列表的模型被 400 拒绝时
// 视为“模型不在分词器能力范围”并记忆到当前配置修订，避免每次运行重复发出无效计数请求；
// 列表内模型的 400 可能是本次请求体/参数问题，只算本次失败。
var zhipuTokenizerModels = map[string]bool{
	"glm-5.3": true, "glm-5.2": true, "glm-5.1": true, "glm-5-turbo": true, "glm-5": true,
	"glm-4.7": true, "glm-4.6": true, "glm-4.6v": true, "glm-4.5": true, "glm-4.5-air": true,
}

func zhipuTokenizerModelSupported(modelID string) bool {
	return zhipuTokenizerModels[strings.ToLower(strings.TrimSpace(modelID))]
}

// Manager 的估算 API：buildContext 与 requestModel 从这里取当前模型的 token 比例。

// estimateRatio 返回当前 Run 固定模型从官方用量校准出的字节→token 比例。
// 装配侧在构造请求后写入 request.EstimateRatio，使 fits 循环内不发网络也保持同一 token 单位。
func (a *agentExecution) estimateRatio() float64 {
	if a == nil || a.manager == nil {
		return defaultTokenRatio
	}
	return a.manager.tokenRatio(a.run.Model)
}

func (m *Manager) tokenRatio(profile *model.Profile) float64 {
	return m.tokenEstimates.ratio(tokenProfileKey(profile))
}

// calibratedRequestTokens 供不走网络的后台请求（长期记忆提炼）使用同一套 token 单位。
func (m *Manager) calibratedRequestTokens(profile *model.Profile, request model.Request) int {
	payload, images := requestEstimateParts(request)
	return tokenCountFromParts(payload, images, m.tokenRatio(profile))
}

// notePromptUsage 用官方响应的 prompt_tokens 校准本地比例。带图片的请求不参与反推：
// 官方 prompt_tokens 含图片 token，而本地比例只作用于文本字节；避免污染比例。
func (m *Manager) notePromptUsage(profile *model.Profile, payloadBytes, promptTokens int) {
	if profile == nil || payloadBytes <= 0 || promptTokens <= 0 {
		return
	}
	m.tokenEstimates.recordRatio(tokenProfileKey(profile), float64(promptTokens)/float64(payloadBytes))
}

type tokenizerWireMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type tokenizerWireFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type tokenizerWireTool struct {
	Type     string                `json:"type"`
	Function tokenizerWireFunction `json:"function"`
}

type tokenizerWireRequest struct {
	Model    string                 `json:"model"`
	Messages []tokenizerWireMessage `json:"messages"`
	Tools    []tokenizerWireTool    `json:"tools,omitempty"`
}

// tokenizerPayload 把最终模型请求转换成分词器可接受的保守形状：
// 智谱分词器只接受 system/user/assistant 文本消息，不支持 tool role 与 tool_calls，
// 因此工具结果转为 user 文本、工具调用追加到 assistant 文本，并保留 tools 定义；
// 图片不发送，由调用方按每张 1024 token 补偿。无法安全转换时放弃官方计数并回退本地。
func tokenizerPayload(request model.Request, profileModel string) ([]byte, bool) {
	out := tokenizerWireRequest{Model: profileModel}
	out.Messages = make([]tokenizerWireMessage, 0, len(request.Messages))
	hasUser := false
	for _, message := range request.Messages {
		content := message.Content
		switch message.Role {
		case "system":
			out.Messages = append(out.Messages, tokenizerWireMessage{Role: "system", Content: content})
		case "assistant":
			for _, call := range message.ToolCalls {
				content += "\n[工具调用] " + call.Name + " " + string(call.Arguments)
			}
			out.Messages = append(out.Messages, tokenizerWireMessage{Role: "assistant", Content: content})
		case "tool":
			hasUser = true
			out.Messages = append(out.Messages, tokenizerWireMessage{Role: "user", Content: "[工具结果] " + content})
		default:
			hasUser = true
			out.Messages = append(out.Messages, tokenizerWireMessage{Role: "user", Content: content})
		}
	}
	// 分词器要求至少一条用户消息；本项目的 header 用户消息通常满足，缺失时放弃官方计数。
	if !hasUser || len(out.Messages) == 0 {
		return nil, false
	}
	if len(request.Tools) > 0 && len(request.Tools) <= tokenizerMaxTools {
		out.Tools = make([]tokenizerWireTool, 0, len(request.Tools))
		for _, tool := range request.Tools {
			parameters := tool.Parameters
			if len(parameters) == 0 {
				parameters = json.RawMessage("{}")
			}
			out.Tools = append(out.Tools, tokenizerWireTool{Type: "function", Function: tokenizerWireFunction{Name: tool.Name, Description: tool.Description, Parameters: parameters}})
		}
	}
	body, err := json.Marshal(out)
	if err != nil {
		return nil, false
	}
	return body, true
}

// officialPromptTokens 请求智谱官方分词器。成功返回官方 prompt_tokens；4xx 视为该模型配置
// 不支持并记忆，429/网络/超时只影响本次调用。请求体与凭据不写日志、不回显。
func (m *Manager) officialPromptTokens(ctx context.Context, profile model.Profile, request model.Request) (int, bool) {
	if ctx == nil || ctx.Err() != nil {
		return 0, false
	}
	supportKey := tokenizerSupportKey(&profile)
	if m.tokenEstimates.isUnsupported(supportKey) {
		return 0, false
	}
	endpoint, ok := m.tokenEstimates.endpointURL(profile)
	if !ok || profile.Credential == "" {
		return 0, false
	}
	body, ok := tokenizerPayload(request, profile.Model)
	if !ok {
		return 0, false
	}
	digest := sha256.Sum256(body)
	if count, hit := m.tokenEstimates.cachedOfficial(digest); hit {
		return count, true
	}
	timeout := m.tokenEstimates.callTimeout()
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case tokenizerGate <- struct{}{}:
		defer func() { <-tokenizerGate }()
	case <-callCtx.Done():
		return 0, false
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, false
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+profile.Credential)
	resp, err := m.tokenEstimates.httpClient().Do(req)
	if err != nil {
		return 0, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 只把配置类明确拒绝（鉴权失败、端点/模型不存在）记忆到当前配置修订；413/422 与其他
		// 4xx 可能只是本次请求体或参数问题，换个请求仍可能成功，只算本次失败。400 仅在模型
		// 不在官方分词器枚举内时视为能力范围外，避免每个 Run 重复两次无效调用。
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
			m.tokenEstimates.markUnsupported(supportKey)
		case http.StatusBadRequest:
			if !zhipuTokenizerModelSupported(profile.Model) {
				m.tokenEstimates.markUnsupported(supportKey)
			}
		}
		return 0, false
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, tokenizerMaxResponse+1))
	if err != nil || len(raw) > tokenizerMaxResponse {
		return 0, false
	}
	var wire struct {
		Usage *struct {
			PromptTokens *float64 `json:"prompt_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &wire) != nil || wire.Usage == nil || wire.Usage.PromptTokens == nil {
		return 0, false
	}
	value := *wire.Usage.PromptTokens
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 10000000 {
		return 0, false
	}
	count := int(math.Ceil(value))
	m.tokenEstimates.cacheOfficial(digest, count)
	return count, true
}

// tokenizerRequestStructure 返回需要额外补偿的结构数量：图片与历史工具调用。
func tokenizerRequestStructure(request model.Request) (images, toolCalls int) {
	for _, message := range request.Messages {
		images += len(message.Images)
		toolCalls += len(message.ToolCalls)
	}
	return images, toolCalls
}

// officialTokenCount 把官方 prompt_tokens 换算成本地压缩/准入口径：加协议安全余量，
// 再补回分词器请求中无法表达的图片与 tool_calls 结构开销。
func officialTokenCount(official int, imageTokens, toolCalls int) int {
	if official < 0 {
		official = 0
	}
	return official*officialSafetyPercent/100 + imageTokens + toolCalls*toolCallTokenCompensation
}

// estimatePromptTokens 是请求装配完成后的首选估算：智谱走官方分词器实测（失败静默回退），
// DeepSeek 等没有计数接口的供应商走已确认 usage 校准后的本地比例；两者都保证单位是 token。
// 网络调用发生在 requestModel 持锁之前，失败只影响本次估算，不阻断推理。
func (a *agentExecution) estimatePromptTokens(ctx context.Context, request model.Request) int {
	payload, images := requestEstimateParts(request)
	ratio := request.EstimateRatio
	if ratio <= 0 && a.run.Model != nil {
		ratio = a.manager.tokenRatio(a.run.Model)
	}
	if a.run.Model != nil && a.run.Model.Provider == model.ProviderZhipu && a.tokenizerFailures < tokenizerFailureLimit {
		profile, err := a.modelProfile()
		if err == nil {
			if official, ok := a.manager.officialPromptTokens(ctx, profile, request); ok {
				// 成功一次即清零连续失败计数：后续请求仍优先官方计数。
				a.tokenizerFailures = 0
				requestImages, toolCalls := tokenizerRequestStructure(request)
				if requestImages == 0 {
					// 官方计数回填校准比例，供下一次请求在分词器不可用或未命中时使用。
					a.manager.notePromptUsage(a.run.Model, payload, official)
				}
				return officialTokenCount(official, requestImages*contextImageTokens, toolCalls)
			}
			a.tokenizerFailures++
		}
	}
	return tokenCountFromParts(payload, images, ratio)
}

// modelProfile 解析 Run 固定模型修订的完整配置（含凭据），只用于官方计数，不写日志。
func (a *agentExecution) modelProfile() (model.Profile, error) {
	if a.run.Model == nil || a.manager == nil || a.manager.deps.Profiles == nil {
		return model.Profile{}, errModelProfileUnavailable
	}
	profile, err := a.manager.deps.Profiles.Resolve(a.run.Model.ID, a.run.Model.Revision, true)
	if err != nil {
		return model.Profile{}, err
	}
	return profile, nil
}

var errModelProfileUnavailable = errors.New("模型配置不可用")
