package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// SSO 回跳白名单（returnOriginRegistry.ts 等价物）：~/.Elysian/config/sso-return-origins.json，
// 用户手写、面板只读。不可用一律退化为空表（不开放跳转），绝不报错拖垮登录与探测：
// 缺文件、坏 JSON、顶层非对象、缺 origins、非数组、version 不为 1、体积超限、路径不是
// 文件，都只让诊断落一行 stderr。单项不合法只丢该项——一条笔误不该废掉全部已登记的工具。
//
// 每次直读不缓存（与凭据 store 同纪律）：改文件即生效，无需重启。读取不校验权限位与
// 属主（内容只是本机 origin 列表，不是秘密）；O_NOFOLLOW 仍保留：最终组件是符号链接
// 时按不可用处理。ENOENT/ELOOP/ENOTDIR 落入「不可用」诊断；EACCES/EMFILE/EIO 等其余
// errno 原样上抛，由路由侧按「白名单不可用」退化处理并另落一行诊断。

// ReturnOriginRegistry 回跳白名单接口。
type ReturnOriginRegistry interface {
	// List 当前允许回跳的 origin；不可用时恒回空表。每次调用直读文件，不做任何缓存。
	// 可能返回 error：超出 fail-closed 集合的 errno（EACCES/EMFILE/EIO 等），调用方
	// 必须退化为「白名单不可用」处理。
	List() ([]string, error)
}

// NewFileReturnOriginRegistry 构造文件版白名单；path 传空串时用 ~/.Elysian 缺省路径。
// diag 是诊断出口（nil 用 os.Stderr），测试注入 buffer 断言诊断文案。
func NewFileReturnOriginRegistry(path string, diag io.Writer) ReturnOriginRegistry {
	if path == "" {
		path = paths.Default.SsoReturnOrigins
	}
	if diag == nil {
		diag = os.Stderr
	}
	return &fileReturnOriginRegistry{path: path, diag: diag}
}

type fileReturnOriginRegistry struct {
	path string
	diag io.Writer
}

// unavailable 打一行「不可用」诊断并回空表。
func (r *fileReturnOriginRegistry) unavailable(reason string) []string {
	fmt.Fprintf(r.diag, "%s：%s\n", SSOOriginsUnavailable, reason)
	return []string{}
}

// List 实现 ReturnOriginRegistry。
func (r *fileReturnOriginRegistry) List() ([]string, error) {
	file, err := openNoFollow(r.path)
	if err != nil {
		if isNoFollowMiss(err) || isENOTDIR(err) {
			return r.unavailable(fmt.Sprintf("文件不可读（%s）", errorReason(wrapErrno(err)))), nil
		}
		return nil, wrapErrno(err)
	}
	defer file.Close()
	fi, err := file.Stat()
	if err != nil {
		return r.unavailable(fmt.Sprintf("读取或解析失败（%s）", errorReason(wrapErrno(err)))), nil
	}
	if !fi.Mode().IsRegular() {
		return r.unavailable("路径不是文件"), nil
	}
	if fi.Size() > ReturnOriginsMaxBytes {
		return r.unavailable(fmt.Sprintf("超过 %d 字节上限", ReturnOriginsMaxBytes)), nil
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return r.unavailable(fmt.Sprintf("读取或解析失败（%s）", errorReason(wrapErrno(err)))), nil
	}
	return r.parseOrigins(data), nil
}

// isENOTDIR 判定路径中某组件不是目录（父目录缺失/被文件占位等场景）。
func isENOTDIR(err error) bool {
	return errorReasonCode(err) == "ENOTDIR"
}

// errorReasonCode 取错误的 errno 符号名（无则回空）。
func errorReasonCode(err error) string {
	if carrier, ok := wrapErrno(err).(codeCarrier); ok {
		return carrier.ErrorCode()
	}
	return ""
}

// parseOrigins 解析白名单内容；不可用形态各打一行诊断并回空表，无效项只丢该项。
func (r *fileReturnOriginRegistry) parseOrigins(data []byte) []string {
	// 按任意 JSON 值解析，区分「JSON 无法解析 / 顶层不是对象 / version 不为 1 /
	// origins 不是数组」四种诊断。
	var top any
	if err := json.Unmarshal(data, &top); err != nil {
		return r.unavailable("JSON 无法解析")
	}
	record, ok := top.(map[string]any)
	if !ok {
		return r.unavailable("顶层不是对象")
	}
	if !isJSONNumberOne(record["version"]) {
		return r.unavailable("version 不为 1")
	}
	entries, ok := record["origins"].([]any)
	if !ok {
		return r.unavailable("origins 不是数组")
	}
	accepted := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, isString := entry.(string)
		if !isString || !NormalizeOrigin(text) {
			r.reportIgnored(entry)
			continue
		}
		accepted = append(accepted, text)
	}
	return accepted
}

// isJSONNumberOne 判定 JSON 值是否是数字 1（1.0 也算，对齐 JS === 的数字语义）。
func isJSONNumberOne(value any) bool {
	number, ok := value.(float64)
	return ok && number == 1
}

// reportIgnored 打一行「忽略无效项」诊断：载荷用 JSON 编码（对齐 TS JSON.stringify(entry)，
// 字符串带双引号、非字符串按其 JSON 形）。
func (r *fileReturnOriginRegistry) reportIgnored(entry any) {
	encoded, err := shared.MarshalJSON(entry)
	if err != nil {
		encoded = []byte("null")
	}
	fmt.Fprintf(r.diag, "%s：%s\n", SSOOriginIgnored, string(encoded))
}

// NewMemoryReturnOriginRegistry 构造内存版白名单（测试用，不碰文件系统）。
func NewMemoryReturnOriginRegistry(origins []string) ReturnOriginRegistry {
	snapshot := make([]string, len(origins))
	copy(snapshot, origins)
	return &memoryReturnOriginRegistry{origins: snapshot}
}

type memoryReturnOriginRegistry struct {
	mu      sync.Mutex
	origins []string
}

// List 实现 ReturnOriginRegistry：回快照拷贝。
func (r *memoryReturnOriginRegistry) List() ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	copied := make([]string, len(r.origins))
	copy(copied, r.origins)
	return copied, nil
}
