package database

import (
	"context"
	"strings"

	"elysian/server/internal/shared"
)

// 接管自装容器：面板原本不持有凭据的官方数据库镜像容器，经用户在数据库页填写管理员凭据、
// 面板单次核验通过后登记为 adopted。此后 Agent 可以复用它建库建用户，页面可以复制凭据。
// 接管只登记，不改容器、不改数据；解除接管只删登记。

// Adopt 核验给定管理员凭据并为自装容器登记 adopted 行。
func (s *databaseService) Adopt(ctx context.Context, containerID, username, password string) (containerInstance, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	if !containerIDPattern.MatchString(containerID) {
		return containerInstance{}, shared.InvalidRequest("容器 ID 无效")
	}
	if password == "" {
		return containerInstance{}, shared.InvalidRequest("接管需要容器里的管理员密码")
	}
	rows, err := s.deps.registry.list()
	if err != nil {
		return containerInstance{}, err
	}
	for _, row := range rows {
		if row.ContainerID == containerID {
			return containerInstance{}, shared.Conflict("该容器已登记，不需要再次接管")
		}
	}
	info, err := s.deps.docker.inspect(ctx, containerID)
	if err != nil {
		return containerInstance{}, err
	}
	if !inspectRunning(info) {
		return containerInstance{}, shared.InvalidRequest("数据库容器未运行，请先启动后再接管")
	}
	engine, versionTag, ref, err := s.adoptedEngine(ctx, info)
	if err != nil {
		return containerInstance{}, err
	}
	if s.deps.admin == nil {
		return containerInstance{}, shared.Unavailable("实例内管理操作未装配，无法核验凭据")
	}
	if username == "" {
		// 各引擎官方镜像的管理员账号不同：MySQL／MariaDB 是 root，Redis 是 default。
		username = defaultAdminUsername(engine, nil)
	}
	secret := databaseSecret{Username: username, Password: password}
	target := adminTarget{containerID: containerID, engine: engine, admin: secret}
	if err := s.deps.admin.verify(ctx, target); err != nil {
		if ctx.Err() != nil {
			return containerInstance{}, ctx.Err()
		}
		return containerInstance{}, shared.InvalidRequest("无法用该凭据登录容器内的数据库，请确认用户名与密码后重试")
	}
	row := databaseRecord{
		ID: newUUID(), Engine: engine, VersionTag: versionTag, ContainerID: containerID, Source: sourceAdopted,
		AccessScope: adoptedAccessScope(info), Admin: secret, State: stateActive,
		CreatedAt: isoNow(s.deps.now), ContainerName: strings.TrimPrefix(asString(field(info, "Name")), "/"),
	}
	// 先投影再落登记：投影失败时不留下孤儿行。
	instance, ok := s.projectContainer(ctx, info, []databaseRecord{row}, ref)
	if !ok {
		return containerInstance{}, shared.Conflict("未能确认该容器的数据库引擎，请检查镜像")
	}
	if err := s.deps.registry.put(row); err != nil {
		return containerInstance{}, err
	}
	return instance, nil
}

// adoptedEngine 判定容器的引擎与明确版本：官方镜像仓库名加上有效版本标签。引用是摘要时用
// 本机镜像清单解析出官方标签；无法确认具体版本就不接管——复用决策需要精确版本。
func (s *databaseService) adoptedEngine(ctx context.Context, info map[string]any) (string, string, string, error) {
	ref := inspectImageRef(info)
	refName, refTag := splitImageRef(ref)
	engine := engineFromImage(obj(field(obj(field(info, "Config")), "Labels")), refName)
	taggedRef := ""
	if engine == "" || !validDatabaseVersion(refTag) {
		images, err := s.deps.listImages(ctx)
		if err != nil {
			return "", "", "", err
		}
		taggedRef = databaseRefsByImageID(images)[stripSha256Prefix(asString(field(info, "Image")))]
		if taggedRef != "" {
			name, tag := splitImageRef(taggedRef)
			if engine == "" {
				engine = engineFromImage(nil, name)
			}
			if !validDatabaseVersion(refTag) {
				refTag = tag
				ref = taggedRef
			}
		}
	}
	if engine == "" {
		return "", "", "", shared.InvalidRequest("只能接管 MySQL、MariaDB 或 Redis 的官方镜像容器")
	}
	if !validDatabaseVersion(refTag) {
		return "", "", "", shared.InvalidRequest("无法确认该容器的明确数据库版本，请使用带版本标签的官方镜像")
	}
	return engine, refTag, ref, nil
}

// adoptedAccessScope 按容器的宿主端口绑定推断访问范围；没有绑定就是仅容器网络。
func adoptedAccessScope(info map[string]any) string {
	for _, port := range containerPorts(info) {
		if port.HostPort == nil {
			continue
		}
		if port.HostIP == "0.0.0.0" || port.HostIP == "::" {
			return scopeAnyHost
		}
		return scopeLocalhost
	}
	return scopeContainerNet
}

// ReleaseAdoption 解除接管：只删登记，不动容器与数据；受管实例不能走这条路径。
func (s *databaseService) ReleaseAdoption(ctx context.Context, containerID string) error {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	rows, err := s.rowsByContainer(containerID)
	if err != nil {
		return err
	}
	// 解除接管会拿走在途部署赖以执行的管理员凭据：先核对该实例没有进行中的部署。
	release, err := s.beginProvisionMutation(ctx, containerID, rows[0].ContainerName)
	if err != nil {
		return err
	}
	defer release()
	if managedContainerRegistration(rows) != nil {
		return shared.InvalidRequest("该实例由面板受管，不能解除接管；不再需要时请在数据库页删除容器及数据")
	}
	for _, row := range rows {
		if row.Source != sourceAdopted {
			continue
		}
		if err := s.deps.registry.remove(row.ID); err != nil {
			return err
		}
	}
	return nil
}
