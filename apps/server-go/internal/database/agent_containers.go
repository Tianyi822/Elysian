package database

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type containerBridge struct {
	facade *AgentFacade
	verify func(context.Context) error
}

var agentDatabaseProtocolVersion = regexp.MustCompile(`^[0-9]+(\.[0-9]+){0,3}$`)

// ContainerBridge shares the page's service and registration mutex. The caller
// consumes its dispatch ticket once; verify checks that same authorization.
func (f *AgentFacade) ContainerBridge(verify func(context.Context) error) seam.AgentDatabaseContainers {
	return &containerBridge{facade: f, verify: verify}
}

func (f *AgentFacade) SetContainerOperationGuard(guard seam.ContainerOperationGuard) {
	if f.Available() {
		f.service.operationGuard = guard
	}
}

type containerOperationRequestKey struct{}

func (s *databaseService) checkContainerMutation(ctx context.Context, id, name string) error {
	if s.operationGuard == nil {
		return nil
	}
	requestID, _ := ctx.Value(containerOperationRequestKey{}).(string)
	return s.operationGuard(ctx, id, name, requestID)
}
func (b *containerBridge) check(ctx context.Context) error {
	if !b.facade.Available() || b.verify == nil {
		return errors.New("数据库登记能力不可用")
	}
	return b.verify(ctx)
}
func (b *containerBridge) rows(id string) ([]databaseRecord, error) {
	rows, err := b.facade.service.deps.registry.list()
	if err != nil {
		return nil, err
	}
	var result []databaseRecord
	for _, row := range rows {
		if row.ContainerID == id {
			result = append(result, row)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}
func containerRevision(rows []databaseRecord) string {
	ordered := append([]databaseRecord(nil), rows...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID < ordered[j].ID })
	raw, _ := json.Marshal(ordered)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (b *containerBridge) Registered(ctx context.Context, id string) (bool, error) {
	if err := b.check(ctx); err != nil {
		return false, err
	}
	rows, err := b.rows(id)
	return len(rows) > 0, err
}

func (b *containerBridge) PrepareCreate(ctx context.Context, input seam.AgentServiceContainerInput, imageID string) (func(context.Context) (any, error), bool, error) {
	if err := b.check(ctx); err != nil {
		return nil, false, err
	}
	ref := strings.SplitN(input.Image, "@", 2)[0]
	colon := strings.LastIndex(ref, ":")
	repo, version := ref, ""
	if colon > strings.LastIndex(ref, "/") {
		repo, version = ref[:colon], ref[colon+1:]
	}
	engine := ""
	for candidate := range engineRepository {
		if imageMatches(candidate, repo) {
			engine = candidate
			break
		}
	}
	if engine == "" {
		return nil, false, nil
	}
	if !validDatabaseVersion(version) || !agentDatabaseProtocolVersion.MatchString(version) {
		return nil, true, shared.InvalidRequest("数据库服务镜像必须使用可核对的纯数字版本，不能使用alpine等变体标签")
	}
	env := map[string]string{}
	for _, entry := range input.Env {
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) == 2 {
			env[parts[0]] = parts[1]
		}
	}
	name := "0"
	prefix := "MYSQL"
	if engine == engineMariaDB {
		prefix = "MARIADB"
	}
	if engine != engineRedis {
		name = env[prefix+"_DATABASE"]
		if name == "" || !sqlNamePattern.MatchString(name) {
			return nil, true, shared.InvalidRequest("数据库服务需通过env提供合法的" + prefix + "_DATABASE初始逻辑库名")
		}
	}
	for key := range env {
		if strings.Contains(key, "PASSWORD") || strings.Contains(key, "ALLOW_EMPTY_PASSWORD") {
			return nil, true, shared.InvalidRequest("数据库密码由后端生成，不能通过env提交")
		}
		if (strings.HasPrefix(key, "MYSQL_") || strings.HasPrefix(key, "MARIADB_")) && key != prefix+"_DATABASE" {
			return nil, true, shared.InvalidRequest("数据库初始化仅支持逻辑库名；账号及密码由后端生成")
		}
	}
	credentialKeys := map[string]bool{prefix + "_ROOT_PASSWORD": true, prefix + "_PASSWORD": true}
	if engine == engineRedis {
		credentialKeys = map[string]bool{"REDIS_PASSWORD": true}
	}
	for _, key := range input.Credentials {
		if !credentialKeys[key] {
			return nil, true, shared.InvalidRequest("数据库凭据变量名与所选引擎不匹配")
		}
	}
	if input.Port != 0 && input.Port != databasePort(engine) {
		return nil, true, shared.InvalidRequest("数据库服务容器只使用引擎标准协议端口")
	}
	expectedPath := "/var/lib/mysql"
	if engine == engineRedis {
		expectedPath = "/data"
	}
	if len(input.Volumes) > 1 || len(input.Volumes) == 1 && input.Volumes[0] != expectedPath {
		return nil, true, shared.InvalidRequest("数据库服务仅使用标准数据目录的专属卷")
	}
	request := map[string]any{"engine": engine, "versionTag": version, "name": name, "user": map[string]any{"username": "ely_" + strings.ReplaceAll(newUUID(), "-", "")[:12], "password": randomAdminPassword()}, "accessScope": scopeContainerNet, "target": map[string]any{"kind": "new", "imageId": stripSha256Prefix(imageID), "containerName": input.Name}}
	switch input.NetworkScope {
	case "localhost":
		request["accessScope"] = scopeLocalhost
	case "any-host":
		request["accessScope"] = scopeAnyHost
		request["hostPort"] = float64(input.HostPort)
		request["confirmPublic"] = true
	}
	validated, err := validateCreateRequest(request)
	if err != nil {
		return nil, true, err
	}
	validated.ServiceOptions = &input
	return func(ctx context.Context) (any, error) {
		ctx = context.WithValue(ctx, containerOperationRequestKey{}, input.RequestID)
		effects := false
		response, err := b.facade.service.createWithReceipt(ctx, validated, &effects)
		if err != nil {
			return nil, bridgeFailure(err, !effects)
		}
		response.Instance.CredentialUsername, response.Instance.MetricsError = "", ""
		return map[string]any{"database": response.Instance, "firewallPort": response.FirewallPort}, nil
	}, true, nil
}

func (b *containerBridge) PrepareChange(ctx context.Context, id, requestID string, change seam.AgentDatabaseChange) (func(context.Context) (any, error), error) {
	if err := b.check(ctx); err != nil {
		return nil, err
	}
	rows, err := b.rows(id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, shared.InvalidRequest("容器没有受管数据库登记")
	}
	if change.ExpectedRevision == "" || containerRevision(rows) != change.ExpectedRevision {
		return nil, shared.InvalidRequest("数据库登记已变化，请重新读取docker_container_inspect")
	}
	for _, row := range rows {
		if row.Source != sourceManaged {
			return nil, shared.InvalidRequest("仅允许变更面板受管数据库")
		}
	}
	anchor := rows[0]
	if change.Action != "create" && change.Action != "remove" {
		return nil, shared.InvalidRequest("databaseChange.action只能为create或remove")
	}
	if anchor.Engine == engineRedis && change.Name != "0" || anchor.Engine != engineRedis && !sqlNamePattern.MatchString(change.Name) {
		return nil, shared.InvalidRequest("逻辑库名无效，Redis仅支持0")
	}
	var target *databaseRecord
	for i := range rows {
		if rows[i].Name == change.Name && rows[i].State != stateEmpty {
			copy := rows[i]
			target = &copy
		}
	}
	if change.Action == "create" && target != nil {
		return nil, shared.InvalidRequest("逻辑库已登记")
	}
	if change.Action == "remove" && target == nil {
		return nil, shared.InvalidRequest("只能删除精确已登记逻辑库")
	}
	if change.Charset != "" && (change.Action != "create" || anchor.Engine == engineRedis || !sqlCharsets[change.Charset]) {
		return nil, shared.InvalidRequest("字符集仅用于SQL逻辑库创建且必须受支持")
	}
	return func(ctx context.Context) (any, error) {
		ctx = context.WithValue(ctx, containerOperationRequestKey{}, requestID)
		s := b.facade.service
		s.mutationMu.Lock()
		defer s.mutationMu.Unlock()
		current, err := b.rows(id)
		if err != nil {
			return nil, bridgeFailure(err, true)
		}
		if containerRevision(current) != change.ExpectedRevision {
			return nil, bridgeFailure(shared.InvalidRequest("数据库登记已变化"), true)
		}
		if change.Action == "remove" {
			effects := false
			if err := s.removeTracked(ctx, target.ID, &effects); err != nil {
				return nil, bridgeFailure(err, !effects)
			}
			return map[string]any{"containerId": id, "name": change.Name, "removed": true}, nil
		}
		request := map[string]any{"engine": anchor.Engine, "versionTag": anchor.VersionTag, "name": change.Name, "user": map[string]any{"username": "ely_" + strings.ReplaceAll(newUUID(), "-", "")[:12], "password": randomAdminPassword()}, "accessScope": anchor.AccessScope, "target": map[string]any{"kind": "managed", "containerId": id}}
		if change.Charset != "" {
			request["charset"] = change.Charset
		}
		validated, err := validateCreateRequest(request)
		if err != nil {
			return nil, bridgeFailure(err, true)
		}
		if protocol, ok := s.deps.protocol.(interface {
			exists(context.Context, databaseRecord, databaseAddress, string) (bool, error)
		}); ok {
			endpoint, err := s.address(ctx, anchor)
			if err != nil {
				return nil, bridgeFailure(err, true)
			}
			exists, err := protocol.exists(ctx, anchor, endpoint, change.Name)
			if err != nil {
				return nil, bridgeFailure(err, true)
			}
			if exists {
				return nil, bridgeFailure(shared.InvalidRequest("目标逻辑库已存在但未登记，不能自动接管"), true)
			}
		}
		effects := false
		response, err := s.createTracked(ctx, validated, &effects)
		if err != nil {
			return nil, bridgeFailure(err, !effects)
		}
		response.Instance.CredentialUsername, response.Instance.MetricsError = "", ""
		return map[string]any{"database": response.Instance}, nil
	}, nil
}

func (b *containerBridge) Inspect(ctx context.Context, id string, detail *seam.AgentDatabaseInspection) (any, error) {
	if err := b.check(ctx); err != nil {
		return nil, err
	}
	rows, err := b.rows(id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		if detail != nil {
			return nil, shared.InvalidRequest("容器没有数据库登记")
		}
		return nil, nil
	}
	values := []any{}
	var selected *databaseRecord
	for _, row := range rows {
		if len(values) < 100 {
			values = append(values, map[string]any{"id": row.ID, "name": row.Name, "engine": row.Engine, "source": row.Source, "state": row.State})
		}
		if detail != nil && row.ID == detail.ID {
			copy := row
			selected = &copy
		}
	}
	result := map[string]any{"revision": containerRevision(rows), "databases": values, "truncated": len(rows) > len(values)}
	if detail != nil {
		if selected == nil {
			return nil, shared.InvalidRequest("指定逻辑库不属于此容器的登记")
		}
		entry := map[string]any{"id": selected.ID}
		if detail.Metadata {
			metadata, metadataErr := b.facade.metadata(ctx, selected.ID)
			if metadataErr == nil {
				if object, ok := metadata.(map[string]any); ok {
					if tables, ok := object["tables"].([]map[string]string); ok && len(tables) > 50 {
						object["tables"], object["truncated"] = tables[:50], true
					}
				}
				entry["metadata"] = metadata
			} else {
				entry["metadataUnavailable"] = true
			}
		}
		if detail.Metrics {
			value, projectionErr := b.facade.service.projection(ctx, *selected)
			if projectionErr == nil {
				entry["metrics"] = map[string]any{"status": value.Status, "storage": value.Storage, "memory": value.Memory, "connections": value.Connections, "needsAttention": value.NeedsAttention}
			} else {
				entry["metricsUnavailable"] = true
			}
		}
		result["selected"] = entry
		if raw, _ := json.Marshal(result); len(raw) > 64<<10 {
			delete(entry, "metadata")
			entry["metadataTruncated"] = true
		}
	}
	for len(values) > 0 {
		raw, _ := json.Marshal(result)
		if len(raw) <= 64<<10 {
			break
		}
		values = values[:len(values)-1]
		result["databases"], result["truncated"] = values, true
	}
	return result, nil
}
func (b *containerBridge) Lifecycle(ctx context.Context, id, action string) (bool, error) {
	if err := b.check(ctx); err != nil {
		return false, err
	}
	s := b.facade.service
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := b.rows(id)
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	if len(rows) != 1 {
		return true, bridgePreflightFailure(shared.InvalidRequest("容器中还有其他已登记数据库，不能执行容器级操作"))
	}
	row := rows[0]
	if err := s.checkContainerMutation(ctx, row.ContainerID, row.ContainerName); err != nil {
		return true, bridgePreflightFailure(err)
	}
	if row.Source != sourceManaged {
		return true, bridgePreflightFailure(shared.InvalidRequest("仅允许操作面板受管数据库容器"))
	}
	if action == "remove" {
		return true, bridgeFailure(s.removeContainer(ctx, row.ID), false)
	}
	docker, ok := s.deps.docker.(*dockerAPI)
	if !ok {
		return true, errors.New("数据库容器控制未接入")
	}
	if action == "restart" {
		if err := docker.agentControl(ctx, row, "stop", s.deps.selfContainerID); err != nil {
			return true, bridgeFailure(err, false)
		}
		action = "start"
	}
	return true, bridgeFailure(docker.agentControl(ctx, row, action, s.deps.selfContainerID), false)
}

func bridgePreflightFailure(err error) error {
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		return &seam.AgentContainerError{Code: "database-container-operation-failed", Message: invalid.Message + "，数据库变更未执行", NotDispatched: true}
	}
	return bridgeFailure(err, false)
}

func bridgeFailure(err error, noBusinessEffect bool) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	message := "数据库操作失败，请回读实际状态，不能自动重试"
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		message = invalid.Message
	}
	if noBusinessEffect {
		message += "，数据库变更未执行"
	}
	return &seam.AgentContainerError{Code: "database-container-operation-failed", Message: message, NoBusinessEffect: noBusinessEffect}
}
