package files

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 文件管理路由（/api/files/*，filesRoutes.ts 等价物）：只做路由分发、守卫调用、
 * query/body 形状解析与 service 调用，业务校验（路径判据、目录存在性、写禁区、
 * 规模上限）留在服务层。守卫链顺序与 TS 版逐字一致：不可用整片 503
 * 「真实文件管理仅在 Docker 容器内可用」→ 同源 403「请求来源不允许」→
 * 读体（415/413/400）→ 端点 → 未知路径 404「未知文件管理端点：METHOD path」。
 *
 * GET 的 path/keyword 对整个字符串做一次 encodeURIComponent 放进 query
 *（URLSearchParams 语义解码，裸 `+` 变空格——前端契约绝不发送裸 `+`）；
 * POST 的路径只随 JSON body 走，无编码问题。尾斜杠由全局 StripTailSlash 归一
 *（对齐 Hono strict:false）。
 */

// Deps 路由装配入参（跨域字段形状按 go-plan §3.8 冻结）：Available 为 false 时整片
// 503；Accounts 缺失同样 503（有可用性没账号通道也不许答）。host 与 service 为域内
// 测试注入位（包内可见，不破坏跨域字段形状）。
type Deps struct {
	Available bool
	Accounts  seam.SystemAccounts

	// host 让真实服务编排跑在注入的宿主原语上（对齐 TS filesHostDeps 测试的注入路径）。
	host hostDeps
	// service 直接替换整条服务链（路由测试用 fake 驱动，不执行任何真实命令）。
	service fileService
}

// NewRouter 构造 /api/files 子路由器：由装配层按 shared.FilesMount 挂载。
// 可用性先行（对齐 TS `!deps.available || !deps.service` 的判定次序）：
// Available=false 时即使注入了 service 也整片 503。
func NewRouter(deps Deps) chi.Router {
	r := chi.NewRouter()
	var svc fileService
	if deps.Available {
		if deps.service != nil {
			svc = deps.service
		} else if deps.Accounts != nil {
			host := deps.host
			if host == nil {
				host = newRealHostDeps()
			}
			svc = newService(host, deps.Accounts)
		}
	}
	if svc == nil {
		// 不可用整片换 503 分支：任意方法、含未知路径与不支持的读请求方法。
		r.HandleFunc("/*", func(w http.ResponseWriter, r *http.Request) {
			shared.SendError(w, http.StatusServiceUnavailable, "真实文件管理仅在 Docker 容器内可用")
		})
		return r
	}

	// 同源守卫先于读体与路由分发：跨源写请求在解析任何请求体之前就被拒绝
	//（未知路径同样先 403 后 404）。
	r.Use(middleware.SameOriginGuard())

	r.Get("/entries", func(w http.ResponseWriter, r *http.Request) {
		dirPath, err := requireQueryPath(r)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		entries, err := svc.List(r.Context(), dirPath)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, entriesResponse{Entries: entries})
	})

	r.Get("/size", func(w http.ResponseWriter, r *http.Request) {
		nodePath, err := requireQueryPath(r)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		totalBytes, err := svc.Size(r.Context(), nodePath)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, sizeResponse{TotalBytes: totalBytes})
	})

	// 空或缺省关键词也接受，返回空数组（对齐 mock；前端对空关键词本就不发请求）。
	r.Get("/search", func(w http.ResponseWriter, r *http.Request) {
		results, err := svc.Search(r.Context(), r.URL.Query().Get("keyword"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, searchResponse{Results: results})
	})

	r.Post("/copy", func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		srcPath, err := requireStringField(body, "srcPath", "源路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		destDirPath, err := requireStringField(body, "destDirPath", "目标目录请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		entry, err := svc.CopyEntry(r.Context(), srcPath, destDirPath)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, entryResponse{Entry: entry})
	})

	r.Post("/move", func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		srcPath, err := requireStringField(body, "srcPath", "源路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		destDirPath, err := requireStringField(body, "destDirPath", "目标目录请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		entry, err := svc.MoveEntry(r.Context(), srcPath, destDirPath)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, entryResponse{Entry: entry})
	})

	r.Post("/rename", func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		path, err := requireStringField(body, "path", "路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		newName, err := requireStringField(body, "newName", "新名称请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		entry, err := svc.RenameEntry(r.Context(), path, newName)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, entryResponse{Entry: entry})
	})

	r.Post("/compress", func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		path, err := requireStringField(body, "path", "路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		entry, err := svc.CompressEntry(r.Context(), path)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, entryResponse{Entry: entry})
	})

	r.Post("/chmod", func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		recursive, ok := body["recursive"].(bool)
		if !ok {
			middleware.WriteError(w, shared.InvalidRequest("递归标记需为布尔值"))
			return
		}
		mode, err := requireStringField(body, "mode", "权限位请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		owner, err := requireStringField(body, "owner", "所有者请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		path, err := requireStringField(body, "path", "路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if err := svc.Chmod(r.Context(), path, filePermissionInput{mode: mode, owner: owner, recursive: recursive}); err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, okResponse{OK: true})
	})

	// 未知端点兜底：剥掉挂载前缀后的相对路径进文案（剥空归一 `/`）。方法不匹配的
	// 已知路径（如 DELETE /entries）同样落这里：对齐 Hono app.all('*') 在方法分发
	// 失败后兜底 404 的行为，不回 405。
	r.HandleFunc("/*", unknownEndpoint)
	r.NotFound(unknownEndpoint)
	r.MethodNotAllowed(unknownEndpoint)
	return r
}

// unknownEndpoint 404 兜底：未知文件管理端点：METHOD <剥掉挂载前缀后的相对路径>。
func unknownEndpoint(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, shared.FilesMount)
	if path == "" {
		path = "/"
	}
	shared.SendError(w, http.StatusNotFound, "未知文件管理端点："+r.Method+" "+path)
}

// requireQueryPath query 的 path 参数：缺失（键不存在）是形状错误；内容合法性
// （相对路径、`..` 段等）由服务层判据负责。空串照常透传（判据层拒绝）。
func requireQueryPath(r *http.Request) (string, error) {
	query := r.URL.Query()
	if _, exists := query["path"]; !exists {
		return "", shared.InvalidRequest("缺少路径参数")
	}
	return query.Get("path"), nil
}

// readBody 读体守卫 + JSON 对象形状归一：守卫失败（415/413/400）已写出响应并回 false。
// body 不是 JSON 对象（数组/字符串/数字/null）时回 nil map，字段查找全部落空，
// 由 requireStringField 按形状错误拒绝（对齐 TS 对非对象 body 的字段取值语义）。
func readBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	parsed, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		middleware.WriteError(w, err)
		return nil, false
	}
	body, _ := parsed.(map[string]any)
	return body, true
}

// requireStringField 请求体里必须是非空字符串的字段：形状错误在路由层拦，
// 语义错误（非法路径/名称）由服务层报。
func requireStringField(body map[string]any, field, message string) (string, error) {
	if body == nil {
		return "", shared.InvalidRequest(message)
	}
	value, exists := body[field]
	if !exists {
		return "", shared.InvalidRequest(message)
	}
	text, isString := value.(string)
	if !isString {
		return "", shared.InvalidRequest(message)
	}
	return text, nil
}

// 响应体形状（键序即 JSON 输出序）。
type entriesResponse struct {
	Entries []fileEntry `json:"entries"`
}

type sizeResponse struct {
	TotalBytes int64 `json:"totalBytes"`
}

type searchResponse struct {
	Results []fileSearchResult `json:"results"`
}

type entryResponse struct {
	Entry fileEntry `json:"entry"`
}

type okResponse struct {
	OK bool `json:"ok"`
}
