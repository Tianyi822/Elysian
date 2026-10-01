package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/seam"
)

/*
 * 操作日志的采集中间件（operationAudit.ts 等价物）：挂在 app 层、所有片路由之前，
 * 任何一片的任何写端点都被它包住。
 *
 * 路由前置定位（go-plan §3.5 落地决策）：以描述符表构建只注册模式的影子 chi 路由，
 * next() 之前 shadow.Match 取「METHOD 路径模板」+ 路径参数——「未声明 summarize 的
 * 端点结构性永不读体」（密码/私钥隔离）与「未命中描述符不记录」两条红线由此保住。
 *
 * 503 判别（对齐 TS「整片 503 不记」）：TS 里不可用片把整张路由表换成通配，matchedRoutes
 * 因此给不出具体路由；Go 侧等价信号是「next() 之后真实路由模式为空或含通配」——即请求
 * 没有落到具体端点上。状态 503 且未落具体端点 → 不记操作日志；落到具体端点的 503
 * （如数据库片的逐路 503）照记 failure。401/403 等前置短路仍照记（TS 里路由表是静态的，
 * 越权尝试正是审计要看的东西）。
 */

// operationSummaryBodyMaxBytes 摘要读体上限：超限即摘要退化为 null。
const operationSummaryBodyMaxBytes = 8 * 1024

// auditBodyBufferMax 采集器为「重放给 handler + 摘要解析」缓冲请求体的上限。
const auditBodyBufferMax = 256 * 1024

// operationLogSource 运行日志里「一次操作」镜像的来源标识。
const operationLogSource = "logs.operation"

// httpLogSource 「请求处理失败」运行日志的来源标识。
const httpLogSource = "server.http"

// loginAttemptKey 登录日志只记这一条路由。
const loginAttemptKey = "POST /api/auth/login"

// LoginRecorder 登录日志出口（seam.Logs 未涵盖的域内扩口；审计中间件类型断言取得，
// 断言失败时登录日志静默缺失——生产装配的 *Service 恒满足）。
type LoginRecorder interface {
	RecordLogin(input LoginRecord)
}

// chiPatternOf 描述符路径 → chi 模式（":id" → "{id}"）。
func chiPatternOf(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		if strings.HasPrefix(segment, ":") {
			segments[i] = "{" + segment[1:] + "}"
		}
	}
	return strings.Join(segments, "/")
}

// shadowRouter 只注册模式的影子路由（描述符表构建）。
var shadowRouter = buildShadowRouter()

// shadowPatternKeys chi 模式键 → 描述符原始键。
var shadowPatternKeys = map[string]string{}

// buildShadowRouter 影子路由构建（init 期一次性）。
func buildShadowRouter() *chi.Mux {
	mux := chi.NewRouter()
	for key := range operationDescriptors {
		method, path, ok := splitDescriptorKey(key)
		if !ok {
			continue
		}
		pattern := chiPatternOf(path)
		mux.MethodFunc(method, pattern, func(http.ResponseWriter, *http.Request) {})
		shadowPatternKeys[method+" "+pattern] = key
	}
	return mux
}

// shadowMatch 在 next() 之前定位具体路由：命中描述符表返回其键、描述符与路径参数。
func shadowMatch(method, path string) (string, *opDescriptor, map[string]string, bool) {
	rctx := chi.NewRouteContext()
	if !shadowRouter.Match(rctx, method, path) {
		return "", nil, nil, false
	}
	pattern := rctx.RoutePattern()
	key, ok := shadowPatternKeys[method+" "+pattern]
	if !ok {
		return "", nil, nil, false
	}
	params := map[string]string{}
	for i, name := range rctx.URLParams.Keys {
		if i < len(rctx.URLParams.Values) {
			params[name] = rctx.URLParams.Values[i]
		}
	}
	return key, operationDescriptors[key], params, true
}

// statusRecorder 记录最终状态码的响应写出器（透传 Flush，流式端点不受影响）。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

// WriteHeader 记首个状态码。
func (r *statusRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

// Flush 透传 Flusher（docker pull/stream 等流式写端点）。
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// resultOf 结果判定：状态码 < 400 为 success。
func resultOf(status int) string {
	if status < 400 {
		return "success"
	}
	return "failure"
}

// callSafely 描述符函数 panic 只让该字段退化（null），绝不吃掉已经生成的响应。
func callSafely(task func() *string) *string {
	defer func() {
		if rec := recover(); rec != nil {
			fmt.Fprintf(os.Stderr, "Elysian 操作日志字段计算失败：%v\n", rec)
		}
	}()
	return task()
}

// readJSONObjectUpTo 解析已缓冲的请求体（≤ maxBytes、JSON 对象）；超限/空体/坏 JSON/
// 非对象一律 nil。只有声明 summarize 的描述符才会走到这里（凭据隔离的唯一开关）。
func readJSONObjectUpTo(body []byte, maxBytes int) map[string]any {
	if body == nil || len(body) > maxBytes {
		return nil
	}
	if trimJS(string(body)) == "" {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	if m, ok := parsed.(map[string]any); ok {
		return m
	}
	return nil
}

// OperationAuditMiddleware app 级采集中间件（go-plan §3.8 冻结签名）。GET/HEAD 只读
// 不谈：直接放行、不记录、不读体。
func OperationAuditMiddleware(svc seam.Logs) func(http.Handler) http.Handler {
	loginRecorder, _ := svc.(LoginRecorder)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			method := strings.ToUpper(r.Method)
			if method == http.MethodGet || method == http.MethodHead {
				next.ServeHTTP(w, r)
				return
			}

			// 路由定位与读体决策在 next() 之前完成：未声明 summarize 的端点恒不读体。
			key, descriptor, params, matched := shadowMatch(method, r.URL.Path)
			var bodyBytes []byte
			if matched && descriptor.summarize != nil && r.Body != nil {
				// 缓冲上限 256 KiB：覆盖各域读体守卫的最大申报上限（64 KiB，websites
				// 256 KiB），超限体（申报超长的先被守卫 413）不无限进内存。
				buffered, err := io.ReadAll(io.LimitReader(r.Body, auditBodyBufferMax))
				if err != nil && len(buffered) == 0 {
					buffered = nil
				}
				bodyBytes = buffered
				// 重置请求体：读出只为重放给 handler 与摘要解析（单次读的 Go 语义）。
				r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			}

			recorder := &statusRecorder{ResponseWriter: w}
			var panicValue any
			func() {
				defer func() { panicValue = recover() }()
				next.ServeHTTP(recorder, r)
			}()
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			if panicValue != nil {
				// 错误在中间件/父层抛出：按 500 记一条，记完原样上抛给上层错误映射。
				status = http.StatusInternalServerError
			}

			// 503 判别：请求没有落到具体端点（真实路由模式为空或含通配）且最终 503
			// → 服务不可用、动作没发生，不记操作日志。
			if matched && !(status == http.StatusServiceUnavailable && !concretelyRouted(r)) {
				var body map[string]any
				if descriptor.summarize != nil {
					body = readJSONObjectUpTo(bodyBytes, operationSummaryBodyMaxBytes)
				}
				input := &opInput{body: body, params: params, status: status}
				summary := (*string)(nil)
				if descriptor.summarize != nil {
					summary = callSafely(func() *string { return descriptor.summarize(input) })
				}
				target := descriptor.targetConst
				if descriptor.targetFn != nil {
					target = callSafely(func() *string { return descriptor.targetFn(input) })
				}
				httpStatus := status
				// 采集失败只进 stderr，绝不影响业务响应（动作已真实执行，回 500 是撒谎）。
				safeWrite(func() {
					svc.RecordOperation(seam.OperationRecord{
						Category:   descriptor.category,
						Action:     descriptor.action,
						Target:     target,
						Summary:    summary,
						Result:     resultOf(status),
						Method:     method,
						Path:       r.URL.Path,
						HTTPStatus: &httpStatus,
					})
				})
			}

			// 登录日志：只记登录端点；状态取最终响应，地址来自 TCP 对端，不读请求体。
			if matched && key == loginAttemptKey && loginRecorder != nil {
				loginStatus := "failure"
				if resultOf(status) == "success" {
					loginStatus = "success"
				}
				safeWrite(func() {
					loginRecorder.RecordLogin(LoginRecord{
						IP:        PeerAddressFromRequest(r),
						UserAgent: r.Header.Get("User-Agent"),
						Status:    loginStatus,
					})
				})
			}

			// 5xx 运行日志：无论描述符是否命中都记；整片 503 不记。
			if status >= 500 && status != http.StatusServiceUnavailable {
				safeWrite(func() {
					svc.Runtime("error", httpLogSource,
						fmt.Sprintf("请求处理失败：%s %s — HTTP %d", method, r.URL.Path, status))
				})
			}

			if panicValue != nil {
				panic(panicValue)
			}
		})
	}
}

// concretelyRouted 请求是否落到了具体端点：next() 之后真实路由模式非空且不含通配。
// （前置短路的 401/403 与未路由的 503 都给不出具体模式。）
func concretelyRouted(r *http.Request) bool {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil {
		return false
	}
	pattern := rctx.RoutePattern()
	return pattern != "" && !strings.Contains(pattern, "*")
}
