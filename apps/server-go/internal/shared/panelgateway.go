package shared

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type panelRequestKey struct{}
type panelRequestInfo struct {
	Peer         string
	FrontendPort int
}

const gatewayTokenHeader = "X-Elysian-Gateway-Token"
const gatewayPeerHeader = "X-Elysian-Gateway-Peer"

// NewPanelGateway 两个 handler 共用仅存在内存的密钥；本机客户端也不能伪造来源。
func NewPanelGateway(backend http.Handler, frontendPort, backendPort int) (http.Handler, http.Handler, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, nil, err
	}
	token := hex.EncodeToString(secret)
	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(backendPort))}
	proxy := &httputil.ReverseProxy{Rewrite: func(p *httputil.ProxyRequest) {
		p.SetURL(target)
		p.Out.Host = p.In.Host
		p.Out.Header.Del(gatewayTokenHeader)
		p.Out.Header.Del(gatewayPeerHeader)
		p.Out.Header.Set(gatewayTokenHeader, token)
		p.Out.Header.Set(gatewayPeerHeader, p.In.RemoteAddr)
	}, FlushInterval: -1}
	securityProxy := boundedSecurityProxy(proxy, 65*time.Second)
	public := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !PanelIPHost(r.Host, frontendPort) {
			SendError(w, 403, "面板仅允许通过 IP 地址或本机地址访问")
			return
		}
		if r.URL.Path == "/api/security" || strings.HasPrefix(r.URL.Path, "/api/security/") {
			securityProxy.ServeHTTP(w, r)
		} else {
			proxy.ServeHTTP(w, r)
		}
	})
	private := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(peer); ip != nil && ip.IsLoopback() && subtle.ConstantTimeCompare([]byte(r.Header.Get(gatewayTokenHeader)), []byte(token)) == 1 {
			r = r.WithContext(context.WithValue(r.Context(), panelRequestKey{}, panelRequestInfo{r.Header.Get(gatewayPeerHeader), frontendPort}))
		}
		r.Header.Del(gatewayTokenHeader)
		r.Header.Del(gatewayPeerHeader)
		backend.ServeHTTP(w, r)
	})
	return public, private, nil
}

// 安全片只提供 JSON，限时覆盖代理读取响应体；安装、上传及流式通道不经过此包装。
func boundedSecurityProxy(proxy http.Handler, timeout time.Duration) http.Handler {
	return http.TimeoutHandler(proxy, timeout, `{"error":"安全请求超时，操作结果尚未确认，请重新读取状态"}`)
}

func PanelIPHost(host string, port int) bool {
	u, err := url.Parse("http://" + host)
	if err != nil || u.User != nil || u.Host != host {
		return false
	}
	p := u.Port()
	if p == "" {
		p = "80"
	}
	if p != strconv.Itoa(port) {
		return false
	}
	return u.Hostname() == "localhost" || net.ParseIP(u.Hostname()) != nil
}

func TrustedPanelHost(r *http.Request) bool {
	info, ok := r.Context().Value(panelRequestKey{}).(panelRequestInfo)
	return ok && PanelIPHost(r.Host, info.FrontendPort)
}

func PanelPeerAddress(r *http.Request) string {
	if info, ok := r.Context().Value(panelRequestKey{}).(panelRequestInfo); ok {
		return info.Peer
	}
	return r.RemoteAddr
}
