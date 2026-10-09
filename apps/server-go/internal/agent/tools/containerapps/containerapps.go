// Package containerapps 把容器应用工作区与镜像构建任务的只读面封装成 kardia 插件。
//
// 工作区登记表（containerapps.Registry）是按需读写文件的值对象，没有常驻资源，
// 因此本包可以按配置的挂载根自造；构建任务机（containerapps.BuildManager）带一
// 个 30 天清理定时器且没有导出 Close，只能由宿主注入——注入缺省时构建类工具不
// 登记，其余工具照常可用（ADR-0023）。
//
// 工作区写文件、上传、删除与真实构建提交本轮不暴露：它们改动宿主磁盘或触发长
// 任务，等审批层落地后再开。构建预览（PreviewDockerfileBuild/PreviewComposeBuild）
// 同样推迟：它需要 Engine 传输器与完整构建请求，收益低于复杂度。
package containerapps

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domainapps "elysian/server/internal/containerapps"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "containerapps"

// Deps 是宿主注入的域对象。两项都可为空：Workspace 为空时按 Config 自造，
// Builds 为空时不登记构建类工具。
type Deps struct {
	// Workspace 是工作区登记表。
	Workspace *domainapps.Registry
	// Builds 是镜像构建任务机，带常驻定时器，只能由宿主构造并注入。
	Builds BuildTasks
}

// BuildTasks 是工具需要的最小任务接口；生产注入 *containerapps.BuildManager。
// 接口只持有宿主对象，测试可以用替身而不启动任务机的常驻定时器。
type BuildTasks interface {
	List(slug string) []domainapps.BuildTask
	Get(slug, taskID string) (domainapps.BuildTask, error)
	Cancel(slug, taskID string) error
}

var _ BuildTasks = (*domainapps.BuildManager)(nil)

// Config 是本能力自身的开关。
type Config struct {
	// MountRoot 是绑定挂载根；Deps.Workspace 为空时必填。
	MountRoot string
	// RegistryPath 覆盖登记表文件路径，缺省使用面板 config/container-apps.json。
	RegistryPath string
}

// WorkspaceFile 是一次工作区文件读取的结果。
type WorkspaceFile struct {
	Slug       string `json:"slug"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
	Content    string `json:"content"`
}

// Service 是容器应用工作区能力服务。
type Service struct {
	kardia.Service

	workspace *domainapps.Registry
	builds    BuildTasks
}

// New 构造工作区能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	workspace := deps.Workspace
	if workspace == nil {
		if cfg.MountRoot == "" {
			return nil, errors.New("容器应用能力缺少工作区登记表：请注入 containerapps.Registry，或给出 Config.MountRoot 由本包自造")
		}
		workspace = &domainapps.Registry{MountRoot: cfg.MountRoot, RegistryPath: cfg.RegistryPath}
	}
	if tools.IsNil(deps.Builds) {
		deps.Builds = nil
	}
	service := &Service{workspace: workspace, builds: deps.Builds}
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

// From 取已装载的工作区能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// HasBuilds 报告构建类工具是否可用。
func (s *Service) HasBuilds() bool { return s.builds != nil }

// ListApps 列出全部工作区，按标识排序。
func (s *Service) ListApps(access *kardia.Context) ([]domainapps.Record, error) {
	return s.workspace.List()
}

// LookupApp 按标识取一条工作区登记。
func (s *Service) LookupApp(access *kardia.Context, slug string) (domainapps.Record, error) {
	if err := domainapps.ValidateSlug(slug); err != nil {
		return domainapps.Record{}, err
	}
	return s.workspace.Lookup(slug)
}

// AppDirectory 返回工作区的宿主绝对路径。
func (s *Service) AppDirectory(access *kardia.Context, slug string) (string, error) {
	if err := domainapps.ValidateSlug(slug); err != nil {
		return "", err
	}
	return s.workspace.Directory(slug)
}

// ListWorkspaceFiles 列出工作区里的文件清单。
func (s *Service) ListWorkspaceFiles(access *kardia.Context, slug string) ([]domainapps.FileEntry, error) {
	dir, err := s.AppDirectory(access, slug)
	if err != nil {
		return nil, err
	}
	return domainapps.ListFiles(dir)
}

// ReadWorkspaceFile 读工作区里的一个文本文件。二进制、超大与越界路径都由域侧
// 拒绝，本层不放宽。
func (s *Service) ReadWorkspaceFile(access *kardia.Context, slug, rel string) (WorkspaceFile, error) {
	dir, err := s.AppDirectory(access, slug)
	if err != nil {
		return WorkspaceFile{}, err
	}
	content, entry, err := domainapps.ReadContent(dir, rel)
	if err != nil {
		return WorkspaceFile{}, err
	}
	return WorkspaceFile{
		Slug:       slug,
		Path:       entry.Path,
		Size:       entry.Size,
		ModifiedAt: entry.ModifiedAt,
		Content:    content,
	}, nil
}

// CheckCompose 对 compose 文件里引用的宿主相对路径做保守自检。判定范围与「判定
// 不了」清单同屏返回，与面板的自检口径一致。
func (s *Service) CheckCompose(access *kardia.Context, slug, composeRel string) (domainapps.CheckResult, error) {
	dir, err := s.AppDirectory(access, slug)
	if err != nil {
		return domainapps.CheckResult{}, err
	}
	content, _, err := domainapps.ReadContent(dir, composeRel)
	if err != nil {
		return domainapps.CheckResult{}, err
	}
	return domainapps.CheckCompose(dir, composeRel, content)
}

// ListBuilds 列出某个工作区的构建任务。
func (s *Service) ListBuilds(access *kardia.Context, slug string) ([]domainapps.BuildTask, error) {
	if err := s.requireBuilds(); err != nil {
		return nil, err
	}
	if err := domainapps.ValidateSlug(slug); err != nil {
		return nil, err
	}
	return s.builds.List(slug), nil
}

// GetBuild 取一个构建任务的快照。
func (s *Service) GetBuild(access *kardia.Context, slug, taskID string) (domainapps.BuildTask, error) {
	if err := s.requireBuilds(); err != nil {
		return domainapps.BuildTask{}, err
	}
	if err := domainapps.ValidateSlug(slug); err != nil {
		return domainapps.BuildTask{}, err
	}
	if taskID == "" {
		return domainapps.BuildTask{}, errors.New("任务标识不得为空")
	}
	return s.builds.Get(slug, taskID)
}

// CancelBuild 请求取消一个在跑的构建任务。
func (s *Service) CancelBuild(access *kardia.Context, slug, taskID string) error {
	if err := s.requireBuilds(); err != nil {
		return err
	}
	if err := domainapps.ValidateSlug(slug); err != nil {
		return err
	}
	if taskID == "" {
		return errors.New("任务标识不得为空")
	}
	return s.builds.Cancel(slug, taskID)
}

func (s *Service) requireBuilds() error {
	if s.builds == nil {
		return errors.New("构建任务机未注入：构建类能力不可用，请由宿主注入 containerapps.BuildManager")
	}
	return nil
}

func (s *Service) descriptors() []tools.Descriptor {
	slugSchema := tools.Schema{Type: tools.SchemaString, Description: "工作区标识"}
	descriptors := []tools.Descriptor{
		{
			Name:        "app_list",
			Description: "列出全部容器应用工作区及其宿主目录",
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Handler:     s.handleListApps,
		},
		{
			Name:        "app_lookup",
			Description: "按标识取一条工作区登记",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
				},
			},
			Handler: s.handleLookupApp,
		},
		{
			Name:        "app_directory",
			Description: "返回工作区的宿主绝对路径，供抄进 compose 的绑定挂载",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
				},
			},
			Handler: s.handleAppDirectory,
		},
		{
			Name:        "workspace_list_files",
			Description: "列出工作区里的文件清单（相对路径升序）",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
				},
			},
			Handler: s.handleListWorkspaceFiles,
		},
		{
			Name:        "workspace_read_file",
			Description: "读工作区里的一个 UTF-8 文本文件；二进制与超大文件由域侧拒绝",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug", "path"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
					"path": {Type: tools.SchemaString, Description: "工作区内的相对路径"},
				},
			},
			Handler: s.handleReadWorkspaceFile,
		},
		{
			Name:        "compose_check",
			Description: "对 compose 里引用的宿主相对路径做保守自检，同时返回判定不了的清单",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug", "compose"},
				Properties: map[string]tools.Schema{
					"slug":    slugSchema,
					"compose": {Type: tools.SchemaString, Description: "compose 文件的工作区相对路径"},
				},
			},
			Handler: s.handleComposeCheck,
		},
	}
	if s.builds == nil {
		return descriptors
	}
	return append(descriptors,
		tools.Descriptor{
			Name:        "build_list",
			Description: "列出某个工作区的镜像构建任务",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
				},
			},
			Handler: s.handleListBuilds,
		},
		tools.Descriptor{
			Name:        "build_get",
			Description: "取一个镜像构建任务的快照",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug", "task"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
					"task": {Type: tools.SchemaString, Description: "任务标识"},
				},
			},
			Handler: s.handleGetBuild,
		},
		tools.Descriptor{
			Name:        "build_cancel",
			Description: "请求取消一个在跑的镜像构建任务",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"slug", "task"},
				Properties: map[string]tools.Schema{
					"slug": slugSchema,
					"task": {Type: tools.SchemaString, Description: "任务标识"},
				},
			},
			Handler: s.handleCancelBuild,
		},
	)
}

func (s *Service) handleListApps(access *kardia.Context, _ tools.Arguments) (any, error) {
	records, err := s.ListApps(access)
	if err != nil {
		return nil, err
	}
	if records == nil {
		records = []domainapps.Record{}
	}
	return records, nil
}

func (s *Service) handleLookupApp(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	return s.LookupApp(access, slug)
}

func (s *Service) handleAppDirectory(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	dir, err := s.AppDirectory(access, slug)
	if err != nil {
		return nil, err
	}
	return map[string]any{"slug": slug, "directory": dir}, nil
}

func (s *Service) handleListWorkspaceFiles(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	return s.ListWorkspaceFiles(access, slug)
}

func (s *Service) handleReadWorkspaceFile(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	rel, _ := tools.StringArg(args, "path")
	return s.ReadWorkspaceFile(access, slug, rel)
}

func (s *Service) handleComposeCheck(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	compose, _ := tools.StringArg(args, "compose")
	return s.CheckCompose(access, slug, compose)
}

func (s *Service) handleListBuilds(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	tasks, err := s.ListBuilds(access, slug)
	if err != nil {
		return nil, err
	}
	if tasks == nil {
		tasks = []domainapps.BuildTask{}
	}
	return tasks, nil
}

func (s *Service) handleGetBuild(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	taskID, _ := tools.StringArg(args, "task")
	return s.GetBuild(access, slug, taskID)
}

func (s *Service) handleCancelBuild(access *kardia.Context, args tools.Arguments) (any, error) {
	slug, _ := tools.StringArg(args, "slug")
	taskID, _ := tools.StringArg(args, "task")
	if err := s.CancelBuild(access, slug, taskID); err != nil {
		return nil, err
	}
	return map[string]any{"slug": slug, "task": taskID, "cancelled": true}, nil
}
