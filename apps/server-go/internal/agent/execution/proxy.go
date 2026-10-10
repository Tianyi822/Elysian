package execution

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/agent/execution/config"
)

// 所有 DNS 结果先验证，再把其中一个已验证 IP 固定给 Dial，避免二次解析。
func (e *Executor) dialTarget(ctx context.Context, grant *config.Grant, scheme, host string, port int) (net.Conn, error) {
	if grant == nil || len(grant.Network) == 0 {
		return nil, problem(403, "execution-network-denied", "未授予目标网络访问")
	}
	endpoint := config.NetworkEndpoint{Scheme: scheme, Host: host, Port: port}
	if host != strings.ToLower(host) || strings.HasSuffix(host, ".") || strings.ContainsAny(host, "/\\\x00@?#") || port < 1 || port > 65535 {
		return nil, problem(403, "execution-network-denied", "网络目标无效")
	}
	allowed := false
	for _, target := range grant.Network {
		if target == endpoint {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, problem(403, "execution-network-denied", "网络目标不在授权列表内")
	}
	ips, err := e.options.LookupIP(ctx, host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, problem(502, "execution-dns", "授权网络目标解析失败")
	}
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip.IP)
		if !ok || config.CheckNetworkAddress(*grant, endpoint, addr.Unmap()) != nil {
			return nil, problem(403, "execution-network-denied", "网络目标解析到禁止地址")
		}
	}
	conn, err := e.options.DialContext(ctx, "tcp", net.JoinHostPort(ips[0].IP.String(), strconv.Itoa(port)))
	if err != nil {
		return nil, problem(502, "execution-network", "授权网络目标连接失败")
	}
	return conn, nil
}
func (p *Process) openProxy(f frame) {
	deny := func() {
		_ = p.send(frame{Kind: "proxy-opened", ID: f.ID, Error: "网络目标未获准或连接失败"})
	}
	if !identityPattern.MatchString(f.ID) {
		deny()
		return
	}
	p.mu.Lock()
	if _, exists := p.proxies[f.ID]; exists || p.proxyCount >= 64 || len(p.proxies) >= 4 {
		p.mu.Unlock()
		deny()
		return
	}
	p.proxyCount++
	p.proxies[f.ID] = nil
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
	conn, err := p.executor.dialTarget(ctx, p.grant, f.Scheme, f.Host, f.Port)
	cancel()
	if err != nil {
		p.mu.Lock()
		delete(p.proxies, f.ID)
		p.mu.Unlock()
		deny()
		return
	}
	p.mu.Lock()
	_, exists := p.proxies[f.ID]
	if !exists || p.ctx.Err() != nil {
		p.mu.Unlock()
		conn.Close()
		return
	}
	p.proxies[f.ID] = conn
	p.mu.Unlock()
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	if err = p.send(frame{Kind: "proxy-opened", ID: f.ID}); err != nil {
		p.closeProxy(f.ID)
		return
	}
	defer p.closeProxy(f.ID)
	buf := make([]byte, 32<<10)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			p.mu.Lock()
			p.proxyBytes += int64(n)
			over := p.proxyBytes > 16<<20
			p.mu.Unlock()
			if over {
				p.fail(problem(413, "execution-network-limit", "代理传输超过总量上限"))
				return
			}
			if p.send(frame{Kind: "proxy-data", ID: f.ID, Data: buf[:n]}) != nil {
				return
			}
		}
		if err != nil {
			_ = p.send(frame{Kind: "proxy-close", ID: f.ID})
			return
		}
	}
}
func (p *Process) proxyData(f frame) error {
	p.mu.Lock()
	conn := p.proxies[f.ID]
	p.proxyBytes += int64(len(f.Data))
	over := p.proxyBytes > 16<<20
	p.mu.Unlock()
	if over {
		return problem(413, "execution-network-limit", "代理传输超过总量上限")
	}
	if conn == nil {
		return protocolError()
	}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write(f.Data); err != nil {
		p.closeProxy(f.ID)
		_ = p.send(frame{Kind: "proxy-close", ID: f.ID})
	}
	return nil
}
func (p *Process) closeProxy(id string) {
	p.mu.Lock()
	conn := p.proxies[id]
	delete(p.proxies, id)
	p.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}
