package app

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func staticTestFS() fstest.MapFS {
	big := strings.Repeat("console.log('elysian');\n", 200)
	return fstest.MapFS{
		"dist/index.html":           {Data: []byte("<!doctype html><html><body>app</body></html>")},
		"dist/assets/app-abc123.js": {Data: []byte(big)},
		"dist/favicon.svg":          {Data: []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)},
		"dist/notes.txt":            {Data: []byte(strings.Repeat("notice\n", 200))},
	}
}

func staticRequest(t *testing.T, h http.HandlerFunc, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func gunzip(t *testing.T, body []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("响应体不是合法 gzip：%v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("解压失败：%v", err)
	}
	return string(out)
}

func TestStaticGzipNegotiation(t *testing.T) {
	h := spaHandler(staticTestFS())
	raw := string(staticTestFS()["dist/assets/app-abc123.js"].Data)

	gz := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip"})
	if gz.Code != http.StatusOK || gz.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip 协商未命中：code=%d encoding=%q", gz.Code, gz.Header().Get("Content-Encoding"))
	}
	if got := gunzip(t, gz.Body.Bytes()); got != raw {
		t.Fatal("gzip 解压后与原文不符")
	}
	if gz.Header().Get("Content-Length") != strconv.Itoa(len(gz.Body.Bytes())) {
		t.Fatalf("Content-Length 与 gzip 体不符：%q", gz.Header().Get("Content-Length"))
	}
	if gz.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatal("gzip 响应缺 Vary")
	}
	if !strings.HasSuffix(gz.Header().Get("ETag"), `-g"`) {
		t.Fatalf("gzip 表示 ETag 应带 -g 后缀：%q", gz.Header().Get("ETag"))
	}

	for _, encoding := range []string{"", "br", "gzip;q=0", "deflate"} {
		rec := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": encoding})
		if rec.Header().Get("Content-Encoding") != "" {
			t.Fatalf("Accept-Encoding=%q 不应压缩，却得 %q", encoding, rec.Header().Get("Content-Encoding"))
		}
		if rec.Body.String() != raw {
			t.Fatalf("Accept-Encoding=%q 身份体与原文不符", encoding)
		}
		if rec.Header().Get("Vary") != "Accept-Encoding" {
			t.Fatalf("Accept-Encoding=%q 身份响应缺 Vary", encoding)
		}
		if rec.Header().Get("Content-Length") != strconv.Itoa(len(raw)) {
			t.Fatalf("Accept-Encoding=%q 身份 Content-Length 不符", encoding)
		}
	}
}

func TestStaticCacheControl(t *testing.T) {
	h := spaHandler(staticTestFS())
	cases := []struct{ target, want string }{
		{"/assets/app-abc123.js", "public, max-age=31536000, immutable"},
		{"/", "no-cache"},
		{"/index.html", "no-cache"},
		{"/some/deep/link", "no-cache"}, // SPA 回落
		{"/favicon.svg", "public, max-age=3600"},
		{"/notes.txt", "public, max-age=3600"},
	}
	for _, c := range cases {
		rec := staticRequest(t, h, http.MethodGet, c.target, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s code=%d，期望 200", c.target, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != c.want {
			t.Fatalf("%s Cache-Control=%q，期望 %q", c.target, got, c.want)
		}
	}
}

func TestStaticContentTypes(t *testing.T) {
	h := spaHandler(staticTestFS())
	cases := []struct{ target, want string }{
		{"/", "text/html; charset=utf-8"},
		{"/some/deep/link", "text/html; charset=utf-8"},
		{"/favicon.svg", "image/svg+xml"},
		{"/notes.txt", "text/plain; charset=utf-8"},
		{"/assets/app-abc123.js", "text/javascript; charset=utf-8"},
	}
	for _, c := range cases {
		rec := staticRequest(t, h, http.MethodGet, c.target, nil)
		if got := rec.Header().Get("Content-Type"); got != c.want {
			t.Fatalf("%s Content-Type=%q，期望 %q", c.target, got, c.want)
		}
	}
}

func TestStaticBelowThresholdNotCompressed(t *testing.T) {
	h := spaHandler(staticTestFS())
	rec := staticRequest(t, h, http.MethodGet, "/favicon.svg", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("低于阈值的 favicon 不应压缩")
	}
}

func TestStaticETag304(t *testing.T) {
	h := spaHandler(staticTestFS())
	gz := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip"})
	etagGz := gz.Header().Get("ETag")
	identity := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", nil)
	etagRaw := identity.Header().Get("ETag")
	if etagGz == etagRaw {
		t.Fatal("gzip 与身份表示的 ETag 必须不同")
	}

	notModified := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": etagGz})
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("命中 ETag 应 304 空体：code=%d len=%d", notModified.Code, notModified.Body.Len())
	}
	if notModified.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatal("304 缺 Vary")
	}

	star := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"If-None-Match": "*"})
	if star.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match:* 应 304，得 %d", star.Code)
	}

	// 身份 ETag 配 gzip 协商属不同表示，不应 304。
	cross := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": etagRaw})
	if cross.Code != http.StatusOK {
		t.Fatalf("跨表示 ETag 不应 304，得 %d", cross.Code)
	}

	stale := staticRequest(t, h, http.MethodGet, "/assets/app-abc123.js", map[string]string{"If-None-Match": `"deadbeef"`})
	if stale.Code != http.StatusOK {
		t.Fatalf("不匹配 ETag 应 200，得 %d", stale.Code)
	}
}

func TestStaticHeadAndMethod(t *testing.T) {
	h := spaHandler(staticTestFS())
	head := staticRequest(t, h, http.MethodHead, "/assets/app-abc123.js", map[string]string{"Accept-Encoding": "gzip"})
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD 应 200 空体：code=%d len=%d", head.Code, head.Body.Len())
	}
	if head.Header().Get("Content-Length") == "" || head.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("HEAD 应带 Content-Length 与 Content-Encoding")
	}
	post := staticRequest(t, h, http.MethodPost, "/", nil)
	if post.Code != http.StatusNotFound {
		t.Fatalf("非 GET/HEAD 应 404，得 %d", post.Code)
	}
}

func TestStaticPlaceholder404(t *testing.T) {
	rec := staticRequest(t, spaHandler(fstest.MapFS{}), http.MethodGet, "/dashboard", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("占位 dist 应 404，得 %d", rec.Code)
	}
}
