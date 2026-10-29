package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"

	"elysian/server/internal/paths"
)

// AgentFacade deliberately has neither Reveal nor OpenSession. SQL text and
// database credentials never cross this interface.
type AgentFacade struct {
	service     *databaseService
	authorize   func(context.Context) error
	taskMu      sync.Mutex
	tasks       map[string]agentTaskRecord
	taskRoot    string
	taskCtx     context.Context
	taskStop    context.CancelFunc
	taskCancels map[string]context.CancelFunc
	taskWG      sync.WaitGroup
	taskDone    chan struct{}
	taskClosed  bool
}

func NewAgentFacade(deps Deps) *AgentFacade {
	f := &AgentFacade{authorize: deps.AgentAuthorize}
	if deps.EngineAvailable && deps.Engine != nil && deps.Views != nil {
		f.service = newDatabaseService(serviceDeps{registry: newFileDatabaseRegistry(filepath.Join(paths.ConfigDir, "databases.json")), docker: newDockerAPI(deps.Engine, deps.Views.ListImages, deps.Views.Policy().ReservedPorts), protocol: newProtocolAPI(), listImages: deps.Views.ListImages, listContainers: deps.Views.ListContainers, selfContainerID: deps.SelfID, portOpener: deps.PortOpener})
	}
	return f
}

func (f *AgentFacade) Available() bool { return f != nil && f.service != nil }
func (f *AgentFacade) check(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !f.Available() || f.authorize == nil {
		return errors.New("数据库能力未就绪")
	}
	return f.authorize(ctx)
}
func agentRecordDigest(row databaseRecord) string {
	raw, _ := json.Marshal(row)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (f *AgentFacade) List(ctx context.Context) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	rows, err := f.service.deps.registry.list()
	if err != nil {
		return nil, errors.New("读取数据库登记失败")
	}
	values := make([]any, 0, min(len(rows), 200))
	for i, row := range rows {
		if i == 200 {
			break
		}
		value, err := f.service.projection(ctx, row)
		if err != nil {
			return nil, errors.New("读取数据库状态失败")
		}
		value.MetricsError, value.CredentialUsername = "", ""
		values = append(values, map[string]any{"database": value, "version": agentRecordDigest(row)})
	}
	return map[string]any{"databases": values, "truncated": len(rows) > 200}, nil
}

func (f *AgentFacade) Metadata(ctx context.Context, id string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	row, err := f.service.record(id)
	if err != nil {
		return nil, errors.New("数据库不存在")
	}
	address, _, err := f.service.checked(ctx, row)
	if err != nil {
		return nil, errors.New("数据库身份、版本或授权核验失败")
	}
	result := map[string]any{"id": row.ID, "engine": row.Engine, "name": row.Name, "version": agentRecordDigest(row)}
	if row.Engine == engineRedis {
		return result, nil
	}
	db, err := mysqlConnect(address, row.User, row.Name)
	if err != nil {
		return nil, errors.New("读取数据库元数据失败")
	}
	defer db.Close()
	queryCtx, cancel := context.WithTimeout(ctx, mysqlQueryTimeout)
	defer cancel()
	rows, err := db.QueryContext(queryCtx, "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE table_schema = ? ORDER BY TABLE_NAME LIMIT 201", row.Name)
	if err != nil {
		return nil, errors.New("读取数据库元数据失败")
	}
	defer rows.Close()
	tables := []map[string]string{}
	for rows.Next() {
		var name, kind string
		if err := rows.Scan(&name, &kind); err != nil {
			return nil, errors.New("读取数据库元数据失败")
		}
		if len(tables) == 200 {
			result["truncated"] = true
			break
		}
		tables = append(tables, map[string]string{"name": name, "kind": kind})
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("读取数据库元数据失败")
	}
	result["tables"] = tables
	return result, nil
}

func (f *AgentFacade) Metrics(ctx context.Context, id string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	row, err := f.service.record(id)
	if err != nil {
		return nil, errors.New("数据库不存在")
	}
	value, err := f.service.projection(ctx, row)
	if err != nil {
		return nil, errors.New("读取数据库指标失败")
	}
	return map[string]any{"id": id, "status": value.Status, "storage": value.Storage, "memory": value.Memory, "connections": value.Connections, "needsAttention": value.NeedsAttention, "version": agentRecordDigest(row)}, nil
}

// AgentDiscoveryError 的文本是固定公开诊断，不携带底层引擎错误。
type AgentDiscoveryError struct {
	Code    string
	Message string
}

func (e *AgentDiscoveryError) Error() string { return e.Message }

func (f *AgentFacade) Discover(ctx context.Context, engine, version string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	if engineRepository[engine] == "" {
		return nil, &AgentDiscoveryError{Code: "database-engine-invalid", Message: "数据库引擎必须为 MySQL、MariaDB 或 Redis"}
	}
	if !validDatabaseVersion(version) {
		return nil, &AgentDiscoveryError{Code: "database-version-invalid", Message: "必须指定明确的数据库版本标签，不能使用 latest；请先查询本地 Docker 镜像列表，使用对应官方镜像的实际版本标签"}
	}
	result, err := f.service.Discover(ctx, engine, &version)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, &AgentDiscoveryError{Code: "database-discovery-failed", Message: "读取数据库镜像和实例失败，请检查 Docker 可用性后重新查询"}
	}
	images := []map[string]string{}
	for i, row := range result.Images {
		if i == 200 {
			break
		}
		images = append(images, map[string]string{"id": row.ID, "name": row.Name, "tag": row.Tag})
	}
	containers := result.Containers
	if len(containers) > 200 {
		containers = containers[:200]
	}
	return map[string]any{"images": images, "containers": containers, "truncated": len(result.Images) > 200 || len(result.Containers) > 200}, nil
}

type AgentCreate struct {
	ID            string `json:"id"`
	Expected      string `json:"expected"`
	Engine        string `json:"engine"`
	VersionTag    string `json:"versionTag"`
	Name          string `json:"name"`
	ImageID       string `json:"imageId"`
	ContainerName string `json:"containerName"`
	Charset       string `json:"charset"`
}

// Create generates credentials inside the domain. Agents cannot supply or read
// them, adopt foreign instances, or publish a new database on a public host port.
// Existing instances use the exact registered ID; new ones use new:<name>.
func (f *AgentFacade) Create(ctx context.Context, input AgentCreate) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	return f.createAgent(ctx, input)
}

func (f *AgentFacade) createAgent(ctx context.Context, input AgentCreate) (any, error) {
	return f.createAgentRecording(ctx, input, nil)
}

func (f *AgentFacade) createAgentRecording(ctx context.Context, input AgentCreate, beforeRecord func(databaseRecord) error) (any, error) {
	s := f.service
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	target := map[string]any{"kind": "new", "imageId": input.ImageID, "containerName": input.ContainerName}
	scope := scopeContainerNet
	if input.ContainerName != "" {
		if input.ID != "new:"+input.ContainerName || input.Expected != "missing" {
			return nil, errors.New("新实例必须绑定精确的新建名称及 missing 预期")
		}
	} else {
		row, err := s.record(input.ID)
		if err != nil || row.Source != sourceManaged || row.Engine != input.Engine || row.VersionTag != input.VersionTag {
			return nil, errors.New("必须选择同版本面板受管实例")
		}
		if input.Expected == "" || agentRecordDigest(row) != input.Expected {
			return nil, errors.New("数据库登记版本已变化")
		}
		target = map[string]any{"kind": "managed", "containerId": row.ContainerID}
		scope = row.AccessScope
	}
	request := map[string]any{"engine": input.Engine, "versionTag": input.VersionTag, "name": input.Name, "user": map[string]any{"username": "ely_" + strings.ReplaceAll(newUUID(), "-", "")[:12], "password": randomAdminPassword()}, "accessScope": scope, "target": target}
	if input.Charset != "" {
		request["charset"] = input.Charset
	}
	validated, err := validateCreateRequest(request)
	if err != nil {
		return nil, errors.New("数据库创建参数无效")
	}
	executor := s
	if beforeRecord != nil {
		deps := s.deps
		deps.registry = &agentTaskRegistry{databaseRegistry: deps.registry, beforeRecord: beforeRecord}
		executor = newDatabaseService(deps)
	}
	result, err := executor.create(ctx, validated)
	if err != nil {
		return nil, errors.New("数据库创建结果未确认，请回读登记和实例状态，不能自动重试")
	}
	result.Instance.MetricsError, result.Instance.CredentialUsername = "", ""
	return map[string]any{"database": result.Instance}, nil
}

// Lifecycle revalidates the immutable registration under the same mutex used
// by HTTP mutations. Only panel-managed databases can be changed by the Agent.
func (f *AgentFacade) Lifecycle(ctx context.Context, id, expected, action string) (any, error) {
	if err := f.check(ctx); err != nil {
		return nil, err
	}
	return f.lifecycleAgent(ctx, id, expected, action)
}

func (f *AgentFacade) lifecycleAgent(ctx context.Context, id, expected, action string) (any, error) {
	s := f.service
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	row, err := s.record(id)
	if err != nil || row.Source != sourceManaged {
		return nil, errors.New("仅允许操作面板受管数据库")
	}
	if expected == "" || agentRecordDigest(row) != expected {
		return nil, errors.New("数据库登记版本已变化，请重新读取并审批")
	}
	switch action {
	case "reconcile":
		_, err = s.reconcile(ctx, id)
	case "remove":
		err = s.remove(ctx, id)
	case "remove-container":
		err = s.removeContainer(ctx, id)
	case "start", "stop":
		rows, listErr := s.deps.registry.list()
		if listErr != nil {
			return nil, errors.New("数据库登记不可核验")
		}
		for _, other := range rows {
			if other.ContainerID == row.ContainerID && other.ID != row.ID {
				return nil, errors.New("实例中还有其他逻辑库，不能通过单库授权改变整个实例状态")
			}
		}
		if d, ok := s.deps.docker.(*dockerAPI); ok {
			err = d.agentControl(ctx, row, action, s.deps.selfContainerID)
		} else {
			err = errors.New("数据库容器控制未接入")
		}
	default:
		return nil, errors.New("数据库操作未开放")
	}
	if err != nil {
		return nil, errors.New("数据库操作失败，请回读实际状态，不能自动重试")
	}
	return map[string]any{"id": id, "action": action, "completed": true}, nil
}
