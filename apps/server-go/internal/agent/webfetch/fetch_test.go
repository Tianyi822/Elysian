package webfetch

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

const testURL = "http://docs.example.com"

func testClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return New(Options{
		Now: func() time.Time { return time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC) },
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if address != "8.8.8.8:80" && address != "8.8.8.8:8080" {
				t.Errorf("实际拨号未固定公网 IP: %s", address)
			}
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}), server
}

func errorCode(t *testing.T, err error, code string) {
	t.Helper()
	var safe *Error
	if !errors.As(err, &safe) || safe.Code != code {
		t.Fatalf("错误=%v，期望 %s", err, code)
	}
}

func TestFetchHTMLExtractsMainAndSource(t *testing.T) {
	var hits atomic.Int32
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != "GET" || r.URL.String() != "/guide?q=1" || r.Host != "docs.example.com:8080" || r.Header.Get("User-Agent") != "Elysian-WebFetch/1.0" {
			t.Errorf("请求发生变化: %+v", r)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><head><title>中文 &amp; 文档</title></head><body><nav>导航垃圾</nav><article>忽略文章</article><main><h1>安装指南</h1><p>你好 <strong>世界</strong>。</p><ul><li>第一步</li><li>第二步</li></ul><pre>one\n  two</pre><script>恶意脚本</script><style>垃圾样式</style><div hidden>隐藏内容</div><aside>侧栏内容</aside><a href="../next#section">下一页</a><a href="/next">重复链接</a><a href="javascript:alert(1)">脚本链接</a><a href="mailto:test@example.com">邮箱</a><img src="/image.png"></main><footer>页脚</footer></body></html>`)
	})
	result, err := client.Fetch(context.Background(), "HTTP://DOCS.EXAMPLE.COM:8080/guide?q=1#part")
	if err != nil {
		t.Fatal(err)
	}
	if result.Title != "中文 & 文档" || result.URL != "http://docs.example.com:8080/guide?q=1" || result.FinalURL != result.URL || result.StatusCode != 200 || result.ContentType != "text/html" || result.FetchedAt != "2026-10-26T00:00:00Z" || result.Truncated {
		t.Fatalf("元数据不符: %+v", result)
	}
	for _, want := range []string{"安装指南\n你好 世界。", "- 第一步\n- 第二步", `one\n  two`} {
		if !strings.Contains(result.Text, want) {
			t.Errorf("正文缺少 %q: %s", want, result.Text)
		}
	}
	for _, excluded := range []string{"导航垃圾", "忽略文章", "恶意脚本", "垃圾样式", "隐藏内容", "侧栏内容", "页脚"} {
		if strings.Contains(result.Text, excluded) {
			t.Errorf("正文包含 %s", excluded)
		}
	}
	if len(result.Links) != 1 || result.Links[0].URL != "http://docs.example.com:8080/next" || result.Links[0].Text != "下一页" || hits.Load() != 1 {
		t.Fatalf("链接或请求数量不符: %+v hits=%d", result.Links, hits.Load())
	}
}

func TestFetchFormatsAndFallbacks(t *testing.T) {
	for _, test := range []struct{ name, contentType, body, want, code string }{
		{"article", "text/html", `<article>文章正文</article>`, "文章正文", ""},
		{"body", "text/html", `<nav>导航</nav><p>正文</p>`, "正文", ""},
		{"code", "text/html", "<main><pre>one\n  two\n    three</pre></main>", "one\n  two\n    three", ""},
		{"code-indentation", "text/html", "<pre>  one\n    two</pre>", "  one\n    two", ""},
		{"markdown", "text/markdown", "# 中文\n\n- 一", "# 中文\n\n- 一", ""},
		{"plain", "text/plain", "中文\r\n文本", "中文\n文本", ""},
		{"plain-no-type", "", "中文文本", "中文文本", ""},
		{"gbk-html", "text/html; charset=gbk", "<p>\xd6\xd0\xce\xc4</p>", "中文", ""},
		{"gbk-text", "text/plain; charset=gbk", "\xd6\xd0\xce\xc4", "中文", ""},
		{"json", "application/json", `{"中文":"内容"}`, `{"中文":"内容"}`, ""},
		{"json-bom", "application/json", "\xef\xbb\xbf{}", "{}", ""},
		{"json-invalid", "application/json", "{", "", "web-invalid-json"},
		{"encoding-invalid", "text/plain", "\xff\xff", "", "web-invalid-encoding"},
		{"encoding-unknown", "text/plain; charset=unknown-encoding", "abc", "", "web-invalid-encoding"},
		{"pdf", "application/pdf", "%PDF", "", "web-unsupported-content"},
		{"image", "image/png", "image", "", "web-unsupported-content"},
		{"empty", "text/html", "<script>code()</script>", "", "web-empty-content"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
				if test.contentType != "" {
					w.Header().Set("Content-Type", test.contentType)
				}
				fmt.Fprint(w, test.body)
			})
			result, err := client.Fetch(context.Background(), testURL)
			if test.code != "" {
				errorCode(t, err, test.code)
				return
			}
			if err != nil || result.Text != test.want {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestFetchLimitsAndJSONBudget(t *testing.T) {
	client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<main><p>"+strings.Repeat("中<&", 20000)+"</p>")
		for i := 0; i < MaxLinks+5; i++ {
			fmt.Fprintf(w, `<a href="/%d?%s">%s</a>`, i, strings.Repeat("x", 3800), strings.Repeat("文", 300))
		}
		fmt.Fprint(w, "</main>")
	})
	result, err := client.Fetch(context.Background(), testURL)
	raw, _ := json.Marshal(result)
	if err != nil || !result.Truncated || len(result.Text) > TextBytes || !utf8.ValidString(result.Text) || len(result.Links) > MaxLinks || len(raw) > resultBytes {
		t.Fatalf("结果限额未生效: text=%d links=%d json=%d err=%v", len(result.Text), len(result.Links), len(raw), err)
	}
	for _, compressed := range []bool{false, true} {
		t.Run(fmt.Sprint("oversize-", compressed), func(t *testing.T) {
			client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/plain")
				if compressed {
					w.Header().Set("Content-Encoding", "gzip")
					zw := gzip.NewWriter(w)
					defer zw.Close()
					fmt.Fprint(zw, strings.Repeat("x", ResponseBytes+1))
					return
				}
				fmt.Fprint(w, strings.Repeat("x", ResponseBytes+1))
			})
			_, err := client.Fetch(context.Background(), testURL)
			errorCode(t, err, "web-response-too-large")
		})
	}
}

func TestFetchRejectsURLsBeforeDial(t *testing.T) {
	client := New(Options{LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
		t.Fatal("禁止目标不应解析")
		return nil, nil
	}, DialContext: func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("禁止目标不应拨号")
		return nil, nil
	}})
	for _, raw := range []string{"", "/relative", "file:///etc/passwd", "ftp://example.com/a", "http://user:secret@example.com", "http://example.com:0", "http://example.com:65536", "http://example.com:", "http://localhost", "http://metadata.google.internal", "http://[fe80::1%25lo0]", "http://" + strings.Repeat("a", URLBytes), "http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fd00:ec2::254]", "http://100.100.100.200", "http://168.63.129.16", "http://[64:ff9b::7f00:1]"} {
		t.Run(raw[:min(60, len(raw))], func(t *testing.T) {
			if _, err := client.Fetch(context.Background(), raw); err == nil {
				t.Fatal("禁止网址被接受")
			}
		})
	}
}

func TestFetchDNSAndPinnedConnections(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "::1", "fe80::1", "ff02::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"} {
		t.Run(ip, func(t *testing.T) {
			client := New(Options{LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
				return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP(ip)}}, nil
			}, DialContext: func(context.Context, string, string) (net.Conn, error) {
				t.Fatal("混合解析结果不得拨号")
				return nil, nil
			}})
			_, err := client.Fetch(context.Background(), testURL)
			errorCode(t, err, "web-address-denied")
		})
	}
	var lookup atomic.Int32
	client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "public") })
	client.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		if lookup.Add(1) > 1 {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	if _, err := client.Fetch(context.Background(), testURL); err != nil {
		t.Fatal(err)
	}
	_, err := client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-address-denied")
	if lookup.Load() != 2 {
		t.Fatal("连接未重新解析")
	}
	for _, ip := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		t.Run("public-ip-"+ip, func(t *testing.T) {
			addr := netip.MustParseAddr(ip)
			client, server := testClient(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "IP content") })
			client.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) {
				t.Fatal("直接 IP 不应查询 DNS")
				return nil, nil
			}
			client.options.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != net.JoinHostPort(ip, "80") {
					t.Errorf("IP 不符: %s", address)
				}
				return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
			}
			_, err := client.Fetch(context.Background(), "http://"+addrToHost(addr))
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func addrToHost(addr netip.Addr) string {
	if addr.Is6() {
		return "[" + addr.String() + "]"
	}
	return addr.String()
}

func TestFetchRedirectsAndCredentialIsolation(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:1")
	var hits atomic.Int32
	client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Proxy-Authorization") != "" {
			t.Error("请求携带凭据")
		}
		switch r.URL.Path {
		case "/start":
			w.Header().Set("Set-Cookie", "secret=value")
			http.Redirect(w, r, "http://other.example.com/end", 302)
		case "/private":
			http.Redirect(w, r, "http://127.0.0.1/secret", 302)
		case "/dns-private":
			http.Redirect(w, r, "http://internal.example.com/secret", 302)
		case "/credentials":
			http.Redirect(w, r, "http://user:secret@other.example.com/end", 302)
		case "/loop":
			http.Redirect(w, r, "/loop", 302)
		default:
			fmt.Fprint(w, "done")
		}
	})
	client.options.LookupIP = func(_ context.Context, host string) ([]net.IPAddr, error) {
		ip := "8.8.8.8"
		if host == "internal.example.com" {
			ip = "10.0.0.1"
		}
		return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
	}
	result, err := client.Fetch(context.Background(), testURL+"/start")
	if err != nil || result.FinalURL != "http://other.example.com/end" || hits.Load() != 2 {
		t.Fatalf("result=%+v err=%v hits=%d", result, err, hits.Load())
	}
	for path, code := range map[string]string{"/private": "web-address-denied", "/dns-private": "web-address-denied", "/credentials": "web-invalid-url", "/loop": "web-redirect-limit"} {
		before := hits.Load()
		_, err := client.Fetch(context.Background(), testURL+path)
		errorCode(t, err, code)
		want := int32(1)
		if path == "/loop" {
			want = MaxRedirects + 1
		}
		if hits.Load()-before != want {
			t.Errorf("请求数错误 %s: %d", path, hits.Load()-before)
		}
	}
}

func TestFetchFailuresAndCancellation(t *testing.T) {
	client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		fmt.Fprint(w, "private-upstream-body")
	})
	_, err := client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-http-error")
	if strings.Contains(err.Error(), "private-upstream-body") {
		t.Fatal("错误正文泄漏")
	}
	client.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) { return nil, errors.New("secret-dns-diagnostic") }
	_, err = client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-dns-failed")
	if strings.Contains(err.Error(), "secret") {
		t.Fatal("DNS 诊断泄漏")
	}
	client.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	client.options.DialContext = func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("secret-dial-diagnostic")
	}
	_, err = client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-connect-failed")
	if strings.Contains(err.Error(), "secret") {
		t.Fatal("拨号诊断泄漏")
	}
	client.options.DialContext = func(context.Context, string, string) (net.Conn, error) { return nil, context.DeadlineExceeded }
	_, err = client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-timeout")
	errorCode(t, fetchError(context.Background(), context.Background(), context.DeadlineExceeded), "web-timeout")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.Fetch(ctx, testURL)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消未透传: %v", err)
	}
	started := make(chan struct{})
	client, _ = testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	})
	ctx, cancel = context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := client.Fetch(ctx, testURL); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("响应体取消未透传: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消未中止响应体")
	}
	parent := context.Background()
	request, stop := context.WithCancel(parent)
	stop()
	errorCode(t, fetchError(parent, request, errors.New("private")), "web-timeout")
}

func TestFetchTLSValidation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "secret") }))
	defer server.Close()
	client := New(Options{LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}})
	_, err := client.Fetch(context.Background(), "https://docs.example.com")
	errorCode(t, err, "web-request-failed")
}

func TestFetchOwnTimeoutStopsDNS(t *testing.T) {
	client := New(Options{LookupIP: func(ctx context.Context, _ string) ([]net.IPAddr, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}, DialContext: func(context.Context, string, string) (net.Conn, error) {
		t.Error("DNS 超时后不应拨号")
		return nil, errors.New("不应执行")
	}})
	_, err := client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-timeout")
}

func TestFetchDoesNotRetryBrokenRequests(t *testing.T) {
	var hits atomic.Int32
	client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	})
	_, err := client.Fetch(context.Background(), testURL)
	errorCode(t, err, "web-request-failed")
	if hits.Load() != 1 {
		t.Fatalf("失败请求被重放: %d", hits.Load())
	}
}
