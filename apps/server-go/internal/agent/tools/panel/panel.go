// Package panel 把面板维护的只读面封装成 kardia 插件。
//
// 只包 panel.Manager 的信息、更新检查与更新日志三条读路径。Manager.Host 与
// Manager.Source 都是导出接口，由宿主注入（生产是 SystemHost 与 GitHubSource，
// 会跑 systemctl 与访问 GitHub）；本包不代为构造，也不封装 Submit——它的入参类型
// submitInput 未导出，且更新与改端口都是需要人工确认的治理动作（ADR-0023）。
package panel

import (
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainpanel "elysian/server/internal/panel"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "panel"

// DefaultHistoryLimit 是更新日志的缺省条数。
const DefaultHistoryLimit = 20

// Channels 是更新策略的取值。
var Channels = []string{string(domainpanel.ChannelCommit), string(domainpanel.ChannelRelease)}

// Deps 是宿主注入的域对象。
type Deps struct {
	// Manager 是面板维护管理器。Store、Host、Source、Ports、Enabled 与 Executable
	// 全部由宿主按装配层的口径填好。
	Manager domainpanel.Manager
}

// Config 是本能力自身的开关。
type Config struct {
	// HistoryLimit 是更新日志缺省条数，<=0 时取 DefaultHistoryLimit。
	HistoryLimit int
}

// Service 是面板维护能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

func (d Deps) validate() error {
	if d.Manager.Host == nil {
		return errors.New("面板维护能力缺少 Host 实现：systemd 与 ufw 的操作面由宿主注入")
	}
	if d.Manager.Source == nil {
		return errors.New("面板维护能力缺少 Source 实现：上游仓库解析由宿主注入")
	}
	return nil
}

// New 构造面板维护能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if cfg.HistoryLimit < 0 {
		return nil, fmt.Errorf("更新日志条数不得为负：%d", cfg.HistoryLimit)
	}
	if cfg.HistoryLimit == 0 {
		cfg.HistoryLimit = DefaultHistoryLimit
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

// From 取已装载的面板维护能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// Info 返回面板信息：端口、当前提交、构建时间、维护可用性与最近任务。
func (s *Service) Info(access *kardia.Context) (domainpanel.Info, error) {
	return s.deps.Manager.Info()
}

// CheckUpdate 按更新策略查一次上游，返回可更新到的目标提交或标签。
func (s *Service) CheckUpdate(access *kardia.Context, channel string) (domainpanel.Update, error) {
	picked, err := s.channel(channel)
	if err != nil {
		return domainpanel.Update{}, err
	}
	return s.deps.Manager.Check(tools.Lifetime(access), picked)
}

// History 返回所选策略下的上游提交列表，limit<=0 时取配置缺省值。
func (s *Service) History(access *kardia.Context, channel string, limit int) ([]domainpanel.CommitLog, error) {
	picked, err := s.channel(channel)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = s.cfg.HistoryLimit
	}
	return s.deps.Manager.Source.History(tools.Lifetime(access), picked, limit)
}

func (s *Service) channel(channel string) (domainpanel.UpdateChannel, error) {
	for _, candidate := range Channels {
		if channel == candidate {
			return domainpanel.UpdateChannel(channel), nil
		}
	}
	return "", fmt.Errorf("更新策略 %q 不合法：只接受 %s", channel, Channels[0]+"|"+Channels[1])
}

func (s *Service) descriptors() []tools.Descriptor {
	return []tools.Descriptor{
		{
			Name:        "panel_info",
			Description: "返回面板信息：端口、当前提交、构建时间、维护能力是否可用与最近任务",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleInfo,
		},
		{
			Name:        "panel_update_check",
			Description: "按更新策略查一次上游，返回可更新到的目标提交或标签；只查不改",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"channel"},
				Properties: map[string]tools.Schema{
					"channel": {Type: tools.SchemaString, Enum: tools.EnumOf(Channels...), Description: "commit=默认分支最新提交，release=最新正式发版标签"},
				},
			},
			Handler: s.handleCheckUpdate,
		},
		{
			Name:        "panel_update_history",
			Description: fmt.Sprintf("列出所选策略下的上游提交标题，缺省 %d 条", s.cfg.HistoryLimit),
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"channel"},
				Properties: map[string]tools.Schema{
					"channel": {Type: tools.SchemaString, Enum: tools.EnumOf(Channels...), Description: "更新策略"},
					"limit":   {Type: tools.SchemaInteger, Description: "条数上限，缺省用配置值"},
				},
			},
			Handler: s.handleHistory,
		},
	}
}

func (s *Service) handleInfo(access *kardia.Context, _ tools.Arguments) (any, error) {
	return s.Info(access)
}

func (s *Service) handleCheckUpdate(access *kardia.Context, args tools.Arguments) (any, error) {
	channel, _ := tools.StringArg(args, "channel")
	return s.CheckUpdate(access, channel)
}

func (s *Service) handleHistory(access *kardia.Context, args tools.Arguments) (any, error) {
	channel, _ := tools.StringArg(args, "channel")
	limit, _ := tools.IntArg(args, "limit")
	logs, err := s.History(access, channel, limit)
	if err != nil {
		return nil, err
	}
	if logs == nil {
		logs = []domainpanel.CommitLog{}
	}
	return logs, nil
}
