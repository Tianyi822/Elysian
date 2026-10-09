// Package websites 把网站登记与宿主 Caddy 通道的只读面封装成 kardia 插件。
//
// 只包 websites.Registry 的列举与 seam.CaddyAdmin 的当前配置读取。网站主服务的
// 九个操作（创建、更新、切换访问方式、启停、日志、删除、代理调和、运行时目录）
// 因 websiteServiceInterface 与 serviceDeps 未导出而不可达；证书存诸的读取会返回
// PEM 材料，一律不封装（ADR-0023 后续项）。
//
// 登记表与 Caddy 通道都由宿主注入：文件版登记表指向 ~/.Elysian/config 下的真实
// 文件，Caddy 通道连的是宿主 unix socket，本包都不代为构造。
package websites

import (
	"encoding/json"
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
	domainwebsites "elysian/server/internal/websites"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "websites"

// Deps 是宿主注入的域对象。
type Deps struct {
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
	if d.Sites == nil {
		return errors.New("网站能力缺少登记表：websites.Registry 由宿主构造并注入")
	}
	if d.Caddy == nil {
		return errors.New("网站能力缺少 Caddy 通道：seam.CaddyAdmin 由宿主构造并注入，宿主无 Caddy 时请注入不可用实现")
	}
	return nil
}

// New 构造网站能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
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
		return nil, err
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

// CaddyConfig 返回宿主 Caddy 的当前配置原文。
func (s *Service) CaddyConfig(access *kardia.Context) (json.RawMessage, error) {
	config, channelErr := s.deps.Caddy.CurrentConfig(tools.Lifetime(access))
	if channelErr != nil {
		return nil, channelErr
	}
	return config, nil
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
	return []tools.Descriptor{
		{
			Name:        "website_list",
			Description: "列出已登记的网站项目（不含来源地址与部署命令）",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleList,
		},
		{
			Name:        "caddy_config_current",
			Description: "读取宿主 Caddy 的当前配置原文；宿主未提供通道时返回中文错误",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleCaddyConfig,
		},
	}
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
