package app

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// 静态资源伺服的压缩与缓存层。只服务嵌入的前端产物（spaHandler 调用），挂在 /api
// 之外，因此 SSE、文件下载与终端字节流不经过这里、不会被压缩或缓冲。
// embed 资源在进程生命周期内不变，故每份资源只压缩一次并缓存身份/gzip 两种表示。

const staticGzipMinBytes = 1024

var staticGzipExts = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".svg": true,
	".txt": true, ".json": true, ".map": true, ".webmanifest": true,
}

type staticAsset struct {
	raw    []byte
	gz     []byte // nil 表示低于阈值或类型不在压缩名单
	etag   string
	etagGz string
	ctype  string
}

type staticStore struct {
	fsys  fs.FS
	mu    sync.Mutex
	items map[string]*staticAsset
}

func newStaticStore(dist fs.FS) *staticStore {
	return &staticStore{fsys: dist, items: map[string]*staticAsset{}}
}

// load 读取并按需压缩一份资源，结果按相对名缓存；未命中返回 fs 的错误供回落判定。
func (s *staticStore) load(name string) (*staticAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.items[name]; ok {
		return a, nil
	}
	raw, err := fs.ReadFile(s.fsys, path.Join("dist", name))
	if err != nil {
		return nil, err
	}
	a := &staticAsset{raw: raw, ctype: mime.TypeByExtension(path.Ext(name))}
	sum := sha256.Sum256(raw)
	a.etag = `"` + hex.EncodeToString(sum[:8]) + `"`
	if staticGzipExts[path.Ext(name)] && len(raw) >= staticGzipMinBytes {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(raw)
		_ = zw.Close()
		a.gz = buf.Bytes()
		a.etagGz = `"` + hex.EncodeToString(sum[:8]) + `-g"`
	}
	s.items[name] = a
	return a, nil
}

// acceptsGzip 解析 Accept-Encoding，尊重 q=0 与通配；未声明 gzip 即不压缩。
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		token := strings.TrimSpace(fields[0])
		if !strings.EqualFold(token, "gzip") && token != "*" {
			continue
		}
		q := 1.0
		for _, param := range fields[1:] {
			param = strings.TrimSpace(param)
			if strings.HasPrefix(param, "q=") {
				if v, err := strconv.ParseFloat(strings.TrimPrefix(param, "q="), 64); err == nil {
					q = v
				}
			}
		}
		return q > 0
	}
	return false
}

// staticCacheControl：带 hash 的 assets 长缓存 immutable；index.html 与 SPA 回落
// 必须 no-cache（维护监控靠新 index.html 引新 hash 感知升级）；其余根文件短缓存。
func staticCacheControl(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}
	if name == "index.html" {
		return "no-cache"
	}
	return "public, max-age=3600"
}

func etagMatch(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "*" || part == etag || strings.TrimPrefix(part, "W/") == etag {
			return true
		}
	}
	return false
}

// writeAsset 先选编码、再比 ETag、最后写头：Vary 对身份编码与 304 也设，避免中间
// 缓存把 gzip 体发给不支持的客户端；304 不写体也不写 Content-Length/Encoding。
func writeAsset(w http.ResponseWriter, r *http.Request, a *staticAsset, cache string) {
	useGz := a.gz != nil && acceptsGzip(r)
	body, etag := a.raw, a.etag
	if useGz {
		body, etag = a.gz, a.etagGz
	}
	h := w.Header()
	h.Set("Vary", "Accept-Encoding")
	h.Set("Cache-Control", cache)
	h.Set("ETag", etag)
	if a.ctype != "" {
		h.Set("Content-Type", a.ctype)
	}
	if match := r.Header.Get("If-None-Match"); match != "" && etagMatch(match, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if useGz {
		h.Set("Content-Encoding", "gzip")
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}
