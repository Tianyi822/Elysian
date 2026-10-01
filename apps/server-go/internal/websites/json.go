package websites

import (
	"errors"
	"io"

	"elysian/server/internal/shared"
)

// 域内共享小件：JSON 编码出口、引擎响应解析辅助与登记/证书存储的固定错误文案。

// marshalJSONCompact 与 TS JSON.stringify 同形：不转义 <>&、无尾随换行。
func marshalJSONCompact(v any) ([]byte, error) {
	return shared.MarshalJSON(v)
}

// errRegistryUnusable 登记文件 stat 校验失败的固定文案。
var errRegistryUnusable = errors.New("网站登记文件权限或内容无效")

// errRegistryInvalid 登记文件根形态不是数组的固定文案（损坏显式报错不静默清空）。
var errRegistryInvalid = errors.New("网站登记文件无效")

// errCertificateFileUnusable 证书文件 stat 校验失败的固定文案。
var errCertificateFileUnusable = errors.New("证书文件权限或内容无效")

// errCertificateFileInvalid 证书文件内容形状不符的固定文案。
var errCertificateFileInvalid = errors.New("证书文件内容无效")

// errCertificateMissing 证书引用在存储中不存在的固定文案。
var errCertificateMissing = errors.New("证书文件不存在")

// readAll 读尽 reader。
func readAll(reader io.Reader) ([]byte, error) {
	return io.ReadAll(reader)
}

// asMap 把 any 收窄为对象；非对象回 (nil, false)。
func asMap(value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	return m, ok
}

// object 把 any 归一为对象：null/非对象一律空表（TS object() 等价物）。
func object(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// asString 取字符串字段。
func asString(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok
}

// engineErrorMessage 引擎错误响应里的 message 字段优先，回退固定文案
// （TS engineMessage 等价物）。
func engineErrorMessage(value any, fallback string) string {
	if m, ok := asMap(value); ok {
		if message, ok := asString(m["message"]); ok && message != "" {
			return message
		}
	}
	return fallback
}
