package firewall

import (
	"context"
	"errors"
	"net/netip"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
)

type AgentFacade struct {
	service   Service
	authorize func(context.Context) error
	ports     []int
	mu        sync.Mutex
	closeOnce sync.Once
}

// AssembleAgent constructs the same service for HTTP and the narrow Agent view.
func AssembleAgent(deps Deps) (chi.Router, *AgentFacade, error) {
	f := &AgentFacade{authorize: deps.AgentAuthorize}
	if deps.Available {
		f.service = deps.service
		if f.service == nil {
			if deps.host != nil {
				f.service = newServiceForMode(deps.host, resolvePorts(deps.Ports), deps.Mode)
			} else {
				var err error
				f.service, err = assembleRealService(deps.DBPath, deps.Now, resolvePorts(deps.Ports), deps.Mode)
				if err != nil {
					return nil, nil, err
				}
			}
		}
	}
	p := resolvePorts(deps.Ports)
	f.ports = []int{22, p.FrontendPort, p.BackendPort}
	deps.service = f.service
	r, err := NewRouterChecked(deps)
	return r, f, err
}

func (f *AgentFacade) Available() bool { return f != nil && f.service != nil }
func (f *AgentFacade) Close(context.Context) error {
	if f != nil {
		f.closeOnce.Do(func() {
			if s, ok := f.service.(*service); ok {
				if t := s.deps.RuleTimes(); t != nil {
					t.Close()
				}
			}
		})
	}
	return nil
}
func (f *AgentFacade) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !f.Available() || f.authorize == nil {
		return errors.New("防火墙能力未就绪")
	}
	return f.authorize(ctx)
}
func (f *AgentFacade) Snapshot(ctx context.Context) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	rules, err := f.service.List()
	if err != nil {
		return nil, errors.New("读取防火墙规则失败")
	}
	for i := range rules {
		rules[i].Note = nil
	}
	ips, err := f.service.ListIpRules()
	if err != nil {
		return nil, errors.New("读取 IP 规则失败")
	}
	for i := range ips {
		ips[i].Note = nil
	}
	toggles, err := f.service.Toggles()
	if err != nil {
		return nil, errors.New("读取防火墙状态失败")
	}
	return map[string]any{"rules": rules, "ipRules": ips, "toggles": toggles}, ctx.Err()
}

// EnsureRule only adds an exact inbound rule for one IP and one unprivileged
// business port. Its complete identity is the grant target, e.g. tcp:8080:10.1.2.3.
func (f *AgentFacade) EnsureRule(ctx context.Context, id string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	parts := strings.SplitN(id, ":", 3)
	if len(parts) != 3 || (parts[0] != "tcp" && parts[0] != "udp") {
		return nil, errors.New("业务规则标识无效")
	}
	port, err := strconv.Atoi(parts[1])
	if err != nil || port < 1024 || port > 65535 || strconv.Itoa(port) != parts[1] {
		return nil, errors.New("仅允许明确的非特权业务端口")
	}
	for _, reserved := range f.ports {
		if port == reserved {
			return nil, errors.New("不能变更系统入口规则")
		}
	}
	ip, err := netip.ParseAddr(parts[2])
	if err != nil || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.String() != parts[2] {
		return nil, errors.New("规则必须指定一个规范业务 IP")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	rows, err := f.service.List()
	if err != nil {
		return nil, errors.New("读取防火墙规则失败")
	}
	for _, row := range rows {
		if row.Protocol == parts[0] && row.Port == port && row.PortTo == nil && row.Policy == "allow" && row.Source == parts[2] && row.Direction == "inbound" {
			return map[string]any{"id": id, "changed": false}, nil
		}
	}
	family := "ipv4"
	if ip.Is6() {
		family = "ipv6"
	}
	_, err = f.service.Create(RuleInput{Protocol: parts[0], Port: float64(port), Family: family, Policy: "allow", Direction: "inbound", Source: parts[2]})
	if err != nil {
		return nil, errors.New("添加业务放行规则失败，请回读确认实际状态")
	}
	return map[string]any{"id": id, "changed": true}, nil
}

func (f *AgentFacade) UnblockIP(ctx context.Context, id string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	ip, err := netip.ParseAddr(id)
	if err != nil || ip.String() != id || !ip.IsGlobalUnicast() {
		return nil, errors.New("解封目标必须是单个规范 IP")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	_, err = f.service.UnblockIp(id)
	if err != nil {
		return nil, errors.New("解封 IP 失败，请回读确认实际状态")
	}
	return map[string]any{"id": id, "unblocked": true}, nil
}
