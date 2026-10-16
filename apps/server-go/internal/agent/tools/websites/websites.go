// Package websites exposes host-injected website views and Agent operations.
// Mutations enter the shared domain service after exact grants and dispatch
// approval; certificate material and raw application/build logs stay outside
// model context. This package never constructs a separate task manager.
package websites

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
	domainwebsites "elysian/server/internal/websites"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "websites"

// Deps 是宿主注入的域对象。
type Deps struct {
	Facade *domainwebsites.AgentFacade
	// Sites 是网站登记表。
	Sites domainwebsites.Registry
	// Caddy 是宿主 Caddy 管理通道。
	Caddy seam.CaddyAdmin
}

// WebsiteSummary 是网站记录的对外投影。刻意不含 GitURL（可能内嵌访问令牌）、
// DeployCommand 与证书引用：工具结果会进模型上下文与审计日志，秘密不进。
type WebsiteSummary struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	Name           string  `json:"name"`
	Category       string  `json:"category"`
	Port           int     `json:"port"`
	AccessMode     string  `json:"accessMode"`
	Domain         *string `json:"domain"`
	Enabled        bool    `json:"enabled"`
	RuntimeVersion *string `json:"runtimeVersion"`
	ContainerName  *string `json:"containerName"`
	ImageRef       *string `json:"imageRef"`
	RootDir        string  `json:"rootDir"`
	ExpiryAt       *string `json:"expiryAt"`
	CreatedAt      string  `json:"createdAt"`
}

// Config 是本能力自身的开关。
type Config struct {
	// ListLimit 是列举条数上限，<=0 时取 DefaultListLimit。
	ListLimit int
}

// DefaultListLimit 是网站列举的缺省上限。
const DefaultListLimit = 200

// Service 是网站能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

func (d Deps) validate() error {
	if tools.IsNil(d.Sites) {
		return errors.New("网站能力缺少登记表：websites.Registry 由宿主构造并注入")
	}
	if tools.IsNil(d.Caddy) {
		return errors.New("网站能力缺少 Caddy 通道：seam.CaddyAdmin 由宿主构造并注入，宿主无 Caddy 时请注入不可用实现")
	}
	return nil
}

// New 构造网站能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	if deps.Facade != nil {
		deps.Sites = deps.Facade.Registry()
		deps.Caddy = deps.Facade.Caddy()
	}
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if cfg.ListLimit < 0 {
		return nil, fmt.Errorf("列举上限不得为负：%d", cfg.ListLimit)
	}
	if cfg.ListLimit == 0 {
		cfg.ListLimit = DefaultListLimit
	}
	service := &Service{deps: deps, cfg: cfg}
	base, err := kardia.NewService(c, ServiceName, service, nil)
	if err != nil {
		return nil, err
	}
	service.Service = base
	if err := tools.RegisterAll(c, service.descriptors()...); err != nil {
		return nil, errors.Join(err, service.Close(context.Background()))
	}
	return service, nil
}

// Plugin 把本能力封成 kardia 插件。
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil},
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}

// From 取已装载的网站能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// List 返回网站投影列表，按 ListLimit 截断。
func (s *Service) List(access *kardia.Context) ([]WebsiteSummary, error) {
	if s.deps.Facade != nil {
		if err := s.deps.Facade.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
	records, err := s.deps.Sites.List(tools.Lifetime(access))
	if err != nil {
		return nil, err
	}
	limit := s.cfg.ListLimit
	summaries := make([]WebsiteSummary, 0, len(records))
	for _, record := range records {
		if limit > 0 && len(summaries) >= limit {
			break
		}
		summaries = append(summaries, summarize(record))
	}
	return summaries, nil
}

// CaddySummary 只投影可供诊断的配置事实，不返回证书私钥、密码哈希与代理头。
type CaddySummary struct {
	Servers       []CaddyServerSummary `json:"servers"`
	TLSConfigured bool                 `json:"tlsConfigured"`
}

// CaddyServerSummary 是一个 HTTP 服务的监听地址与路由数量。
type CaddyServerSummary struct {
	Name       string   `json:"name"`
	Listen     []string `json:"listen"`
	RouteCount int      `json:"routeCount"`
}

// CaddyConfig 返回宿主 Caddy 的当前配置摘要；只解码白名单字段。
func (s *Service) CaddyConfig(access *kardia.Context) (CaddySummary, error) {
	if s.deps.Facade != nil {
		if err := s.deps.Facade.Authorize(tools.Lifetime(access)); err != nil {
			return CaddySummary{}, err
		}
	}
	config, channelErr := s.deps.Caddy.CurrentConfig(tools.Lifetime(access))
	if channelErr != nil {
		return CaddySummary{}, channelErr
	}
	var parsed *struct {
		Apps struct {
			HTTP struct {
				Servers map[string]struct {
					Listen []string          `json:"listen"`
					Routes []json.RawMessage `json:"routes"`
				} `json:"servers"`
			} `json:"http"`
			TLS json.RawMessage `json:"tls"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(config, &parsed); err != nil || parsed == nil {
		return CaddySummary{}, errors.New("宿主 Caddy 返回了无效的配置对象")
	}
	result := CaddySummary{Servers: []CaddyServerSummary{}, TLSConfigured: len(parsed.Apps.TLS) > 0 && string(parsed.Apps.TLS) != "null"}
	for name, server := range parsed.Apps.HTTP.Servers {
		listen := append([]string{}, server.Listen...)
		result.Servers = append(result.Servers, CaddyServerSummary{Name: name, Listen: listen, RouteCount: len(server.Routes)})
	}
	sort.Slice(result.Servers, func(i, j int) bool { return result.Servers[i].Name < result.Servers[j].Name })
	return result, nil
}

func summarize(record domainwebsites.WebsiteRecord) WebsiteSummary {
	return WebsiteSummary{
		ID:             record.ID,
		Kind:           record.Kind,
		Name:           record.Name,
		Category:       record.Category,
		Port:           record.Port,
		AccessMode:     record.AccessMode,
		Domain:         record.Domain,
		Enabled:        record.Enabled,
		RuntimeVersion: record.RuntimeVersion,
		ContainerName:  record.ContainerName,
		ImageRef:       record.ImageRef,
		RootDir:        record.RootDir,
		ExpiryAt:       record.ExpiryAt,
		CreatedAt:      record.CreatedAt,
	}
}

func (s *Service) descriptors() []tools.Descriptor {
	descriptors := []tools.Descriptor{
		{
			Name:        "website_list",
			Description: "列出已登记的网站项目（不含来源地址与部署命令）",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleList,
		},
		{
			Name:        "caddy_config_current",
			Description: "读取宿主 Caddy 的监听地址、路由数量与 TLS 配置状态；不返回证书、认证与代理头原文",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleCaddyConfig,
		},
	}
	for i := range descriptors {
		descriptors[i].Metadata = tools.Metadata{Domain: "website", Action: descriptors[i].Name, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}
	}
	return append(descriptors, s.agentDescriptors()...)
}

func (s *Service) handleList(access *kardia.Context, _ tools.Arguments) (any, error) {
	return s.List(access)
}

func (s *Service) handleCaddyConfig(access *kardia.Context, _ tools.Arguments) (any, error) {
	config, err := s.CaddyConfig(access)
	if err != nil {
		return nil, err
	}
	return config, nil
}
