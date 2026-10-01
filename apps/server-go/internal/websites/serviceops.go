package websites

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"elysian/server/internal/contract"
	"elysian/server/internal/shared"
)

/*
 * 网站域编排动作（websitesService.ts 的 create/update/setAccess/setRunning/logs/
 * remove/reconcileProxy 逐字移植）。四条失败回滚路径的中文消息由「原因 + 恢复状态」
 * 拼接，failures 数组顺序（登记、Caddy 配置、新容器、原容器）影响逐字输出，照抄
 * 拼接次序（盘点 §11.2）。
 */

// Create 创建网站项目：先核对动态目录（503/网络错误先于互斥抛出），再进入互斥与
// 下发队列内做查重、证书、目录、容器与 Caddy 编排；失败回滚容器与证书，站点目录
// 保留（空目录无害）；登记落账后直连模式才做端口自动开放（失败不回滚）。
func (s *websiteService) Create(ctx context.Context, input createRequest) (mutateResult, error) {
	// 先核对动态目录，再进入任何站点目录、证书或 Docker 写操作。HTML 项目用固定
	// 镜像，不查目录（离线时 HTML 创建不受影响）。
	var imageRef *string
	if input.Kind == KindHTML {
		imageRef = stringPtr(WEBSITE_HTML_IMAGE)
	} else {
		report, err := s.deps.runtimeCatalog.Get(ctx)
		if err != nil {
			return mutateResult{}, err
		}
		imageRef = WebsiteRuntimeImageRef(input.Kind, input.RuntimeVersion, &report.Catalog)
	}
	if imageRef == nil {
		return mutateResult{}, shared.InvalidRequest("运行时版本不在正式可选目录内，请刷新版本目录")
	}
	// 全局串行化全部创建：名称（跨类型全局唯一）与域名的查重都是跨 await 的
	// check-then-act，按 kind+name 分键会让并发同名/同域创建双双通过查重。
	if s.inProgress.has(createMutexKey) {
		return mutateResult{}, &shared.InvalidRequestError{Status: 409, Message: "网站项目正在创建，请稍后再试"}
	}
	s.inProgress.add(createMutexKey)
	defer s.inProgress.remove(createMutexKey)

	// 下发队列内的多步编排不随发起方请求取消（TS Promise 语义：执行到完成）。
	opCtx := context.WithoutCancel(ctx)
	var result mutateResult
	var runErr error
	s.queue.run(func() {
		result, runErr = s.createQueued(opCtx, input, *imageRef)
	})
	return result, runErr
}

// createQueued 创建的队列内主体。
func (s *websiteService) createQueued(ctx context.Context, input createRequest, imageRef string) (mutateResult, error) {
	rows, err := s.deps.registry.List(ctx)
	if err != nil {
		return mutateResult{}, err
	}
	for _, row := range rows {
		if row.Name == input.Name {
			return mutateResult{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("项目已存在：%s", input.Name)}
		}
	}
	domain := ""
	if input.Access.Mode == AccessModeDomain {
		domain = input.Access.Domain
	}
	if domain != "" {
		for _, row := range rows {
			if row.Domain != nil && *row.Domain == domain {
				return mutateResult{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("域名已被绑定：%s", domain)}
			}
		}
	}
	if err := s.assertPortAvailable(ctx, input.Port, rows); err != nil {
		return mutateResult{}, err
	}

	var certificate *WebsiteCertificateRef
	if input.Access.Mode == AccessModeDomain {
		material := CertificateMaterial{CertificatePEM: *input.Access.CertificatePEM, PrivateKeyPEM: *input.Access.PrivateKeyPEM}
		metadata, err := ValidateWebsiteCertificate(material, domain, s.deps.trustedRoots, time.Now())
		if err != nil {
			return mutateResult{}, err
		}
		ref, err := s.deps.certificates.Save(ctx, material)
		if err != nil {
			return mutateResult{}, err
		}
		certificate = &WebsiteCertificateRef{Ref: ref, Issuer: metadata.Issuer, NotAfter: metadata.NotAfter, Fingerprint256: metadata.Fingerprint256}
		if _, cerr := s.deps.caddy.CurrentConfig(ctx); cerr != nil {
			if rerr := s.deps.certificates.Remove(ctx, certificate.Ref); rerr != nil {
				return mutateResult{}, rerr
			}
			detail := fallbackDetail(caddyChannelStatus(cerr).Detail, "请重新检测")
			return mutateResult{}, fmt.Errorf("Caddy 管理通道不可用：%s", detail)
		}
	}

	// 目录与镜像先于容器：镜像缺失不建容器；目录建后失败保留（空目录无害）。
	projectID := randomUUID()
	rootDir, err := s.deps.docker.EnsureSiteDir(input.Name, s.deps.mountRoot)
	if err != nil {
		if certificate != nil {
			_ = s.deps.certificates.Remove(ctx, certificate.Ref)
		}
		return mutateResult{}, err
	}
	if err := s.deps.docker.EnsureImage(ctx, imageRef); err != nil {
		if certificate != nil {
			_ = s.deps.certificates.Remove(ctx, certificate.Ref)
		}
		return mutateResult{}, err
	}
	containerName := s.deps.docker.NewContainerName()
	containerID, err := s.deps.docker.Create(ctx, containerCreateInput{
		ImageRef:      imageRef,
		Kind:          input.Kind,
		Version:       versionOrDefault(input.RuntimeVersion),
		ProjectID:     projectID,
		Port:          input.Port,
		BindSource:    rootDir,
		AccessMode:    input.Access.Mode,
		Command:       stringPtr(input.Command),
		ContainerName: containerName,
	})
	if err != nil {
		if certificate != nil {
			_ = s.deps.certificates.Remove(ctx, certificate.Ref)
		}
		return mutateResult{}, err
	}

	row := WebsiteRecord{
		ID:             projectID,
		Kind:           input.Kind,
		Name:           input.Name,
		Port:           input.Port,
		RuntimeVersion: input.RuntimeVersion,
		RootDir:        rootDir,
		AccessMode:     input.Access.Mode,
		Certificate:    certificate,
		ContainerName:  stringPtr(containerName),
		ContainerID:    stringPtr(containerID),
		ImageRef:       stringPtr(imageRef),
		DeployCommand:  stringPtr(input.Command),
		Enabled:        false,
		Category:       CategoryDevelopment,
		ExpiryAt:       nil,
		Note:           input.Note,
		GitURL:         input.GitURL,
		CreatedAt:      isoNowUTC(),
	}
	if domain != "" {
		row.Domain = stringPtr(domain)
	}
	if input.Kind == KindHTML {
		row.RuntimeVersion = nil
	}

	var previousRaw json.RawMessage
	var appliedConfig any
	caddyLoaded := false
	runErr := func() error {
		if domain != "" {
			currentRaw, cerr := s.deps.caddy.CurrentConfig(ctx)
			if cerr != nil {
				return cerr
			}
			previousRaw = json.RawMessage(currentRaw)
			if HasForeignConfig(parseJSONValue(currentRaw), expectedProxyHosts(rows), s.deps.caddy.AdminListen()) {
				return &shared.InvalidRequestError{Status: 409, Message: "宿主 Caddy 存在面板外的配置，拒绝覆盖"}
			}
			sites, serr := s.sitesWithCertificates(ctx, append(append([]WebsiteRecord{}, rows...), row))
			if serr != nil {
				return serr
			}
			configBytes := BuildCaddyConfig(sites, s.deps.caddy.AdminListen())
			appliedConfig = parseJSONValue(configBytes)
			if lerr := s.deps.caddy.Load(ctx, configBytes); lerr != nil {
				return lerr
			}
			caddyLoaded = true
		}
		return s.deps.registry.Put(ctx, row)
	}()
	if runErr != nil {
		reason := runErr.Error()
		rollbackFailure := false
		if caddyLoaded && len(previousRaw) > 0 && parseJSONValue(previousRaw) != nil {
			if lerr := s.deps.caddy.Load(ctx, previousRaw); lerr != nil {
				rollbackFailure = true
			}
		}
		_ = s.deps.docker.RemoveCreated(ctx, containerID)
		if certificate != nil {
			_ = s.deps.certificates.Remove(ctx, certificate.Ref)
		}
		message := fmt.Sprintf("网站创建失败：%s；容器已回滚，站点目录保留", reason)
		if rollbackFailure {
			message += "；原 Caddy 配置恢复失败，配置可能不同步，请重新下发反向代理配置"
		}
		return mutateResult{}, errors.New(message)
	}

	configForProject := appliedConfig
	if configForProject == nil {
		configForProject = s.currentConfigOrNull(ctx)
	}
	project, err := s.projectRow(ctx, row, configForProject)
	if err != nil {
		return mutateResult{}, err
	}
	// 端口自动开放放在登记落账之后：失败不回滚容器（直连端口在宿主本机仍可达，
	// 只是外部不可达），结果如实带回响应由前端呈现。
	var firewallPort *contract.FirewallPortSync
	if input.Access.Mode == AccessModeDirect {
		synced := s.deps.openFirewallPort(ctx, input.Port, "Elysian 网站 "+input.Name)
		firewallPort = &synced
	}
	return mutateResult{Project: project, FirewallPort: firewallPort}, nil
}

// Update 修改设置：note/expiryAt 直接合并；command 变化时（与登记不同）重建容器并
// 迁移运行状态。整记录读改写必须与同项目的启停/删除互斥：否则 update 以陈旧全量
// 记录回写，会静默回滚并发启停刚翻转的 enabled。
func (s *websiteService) Update(ctx context.Context, id string, input updateRequest) (websiteProject, error) {
	if s.inProgress.has(id) {
		return websiteProject{}, &shared.InvalidRequestError{Status: 409, Message: "项目正在执行其他操作"}
	}
	s.inProgress.add(id)
	defer s.inProgress.remove(id)

	row, err := s.record(ctx, id)
	if err != nil {
		return websiteProject{}, err
	}
	updated := copyRecord(row)
	if input.Note != nil {
		updated.Note = input.Note.value
	}
	if input.ExpiryAt != nil {
		updated.ExpiryAt = input.ExpiryAt.value
	}
	commandChanged := input.Command != nil && !deployCommandEquals(input.Command.value, row.DeployCommand)
	if commandChanged {
		if row.Kind == KindHTML {
			return websiteProject{}, shared.InvalidRequest("HTML 项目使用固定 Nginx 启动命令")
		}
		if _, err := WebsiteContainerCmd(row.Kind, input.Command.value); err != nil {
			return websiteProject{}, err
		}
		if row.ContainerID == nil || row.ImageRef == nil {
			return websiteProject{}, &shared.InvalidRequestError{Status: 409, Message: "站点容器不存在，请删除项目后重建"}
		}
		oldRunning := false
		info, err := s.deps.docker.Inspect(ctx, *row.ContainerID)
		if err != nil {
			return websiteProject{}, err
		}
		if value, ok := object(info["State"])["Running"].(bool); ok && value {
			oldRunning = true
		}
		containerName := s.deps.docker.NewContainerName()
		newContainerID, err := s.deps.docker.Create(ctx, containerCreateInput{
			ImageRef:      *row.ImageRef,
			Kind:          row.Kind,
			Version:       versionOrDefault(row.RuntimeVersion),
			ProjectID:     row.ID,
			Port:          row.Port,
			BindSource:    row.RootDir,
			AccessMode:    row.AccessMode,
			Command:       input.Command.value,
			ContainerName: containerName,
		})
		if err != nil {
			return websiteProject{}, err
		}
		stopped := false
		registered := false
		runErr := func() error {
			if oldRunning {
				if err := s.deps.docker.Stop(ctx, *row.ContainerID); err != nil {
					return err
				}
				stopped = true
				if err := s.deps.docker.Start(ctx, newContainerID); err != nil {
					return err
				}
			}
			updated.ContainerID = stringPtr(newContainerID)
			updated.ContainerName = stringPtr(containerName)
			updated.DeployCommand = input.Command.value
			if err := s.deps.registry.Put(ctx, updated); err != nil {
				return err
			}
			registered = true
			_, err := s.deps.docker.RemoveManaged(ctx, containerIdentity{
				ContainerID:     *row.ContainerID,
				ContainerName:   stringOrEmpty(row.ContainerName),
				ProjectID:       row.ID,
				Kind:            row.Kind,
				Version:         versionOrDefault(row.RuntimeVersion),
				ImageRef:        stringOrEmpty(row.ImageRef),
				RootDir:         row.RootDir,
				SelfContainerID: s.deps.selfContainerID,
			})
			return err
		}()
		if runErr != nil {
			var failures []string
			if registered {
				if err := s.deps.registry.Put(ctx, row); err != nil {
					failures = append(failures, "登记")
				}
			}
			_ = s.deps.docker.Stop(ctx, newContainerID)
			if err := s.deps.docker.RemoveCreated(ctx, newContainerID); err != nil {
				failures = append(failures, "新容器")
			}
			if stopped {
				if err := s.deps.docker.Start(ctx, *row.ContainerID); err != nil {
					failures = append(failures, "原容器")
				}
			}
			message := fmt.Sprintf("启动命令保存失败：%s", runErr.Error())
			if len(failures) > 0 {
				message += "；" + strings.Join(failures, "、") + "恢复失败，配置可能不同步"
			} else {
				message += "；原容器已恢复"
			}
			return websiteProject{}, errors.New(message)
		}
		return s.projectRow(ctx, updated, s.currentConfigOrNull(ctx))
	}
	if err := s.deps.registry.Put(ctx, updated); err != nil {
		return websiteProject{}, err
	}
	return s.projectRow(ctx, updated, s.currentConfigOrNull(ctx))
}

// SetAccess 访问方式切换：模式切换重建容器（PortBindings 的 HostIp 随新模式变化），
// 同域名换证书只替换证书不重建容器；无变化短路。双互斥（'create' + id），下发在
// 队列内执行。
func (s *websiteService) SetAccess(ctx context.Context, id string, access accessInput) (mutateResult, error) {
	if s.inProgress.has(createMutexKey) || s.inProgress.has(id) {
		return mutateResult{}, &shared.InvalidRequestError{Status: 409, Message: "项目正在执行其他操作"}
	}
	s.inProgress.add(createMutexKey)
	s.inProgress.add(id)
	defer func() {
		s.inProgress.remove(id)
		s.inProgress.remove(createMutexKey)
	}()

	opCtx := context.WithoutCancel(ctx)
	var result mutateResult
	var runErr error
	s.queue.run(func() {
		result, runErr = s.setAccessQueued(opCtx, id, access)
	})
	return result, runErr
}

// setAccessQueued 访问切换的队列内主体。
func (s *websiteService) setAccessQueued(ctx context.Context, id string, access accessInput) (mutateResult, error) {
	rows, err := s.deps.registry.List(ctx)
	if err != nil {
		return mutateResult{}, err
	}
	var row *WebsiteRecord
	for i := range rows {
		if rows[i].ID == id {
			row = &rows[i]
			break
		}
	}
	if row == nil {
		return mutateResult{}, &shared.InvalidRequestError{Status: 404, Message: fmt.Sprintf("未找到项目 %s", id)}
	}
	domain := ""
	if access.Mode == AccessModeDomain {
		domain = access.Domain
	}
	if domain != "" {
		for _, item := range rows {
			if item.ID != id && item.Domain != nil && *item.Domain == domain {
				return mutateResult{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("域名已被绑定：%s", domain)}
			}
		}
	}
	var certificate *WebsiteCertificateRef
	stagedRef := ""
	if access.Mode == AccessModeDomain {
		if access.CertificatePEM != nil && *access.CertificatePEM != "" && access.PrivateKeyPEM != nil && *access.PrivateKeyPEM != "" {
			material := CertificateMaterial{CertificatePEM: *access.CertificatePEM, PrivateKeyPEM: *access.PrivateKeyPEM}
			metadata, err := ValidateWebsiteCertificate(material, access.Domain, s.deps.trustedRoots, time.Now())
			if err != nil {
				return mutateResult{}, err
			}
			stagedRef, err = s.deps.certificates.Save(ctx, material)
			if err != nil {
				return mutateResult{}, err
			}
			certificate = &WebsiteCertificateRef{Ref: stagedRef, Issuer: metadata.Issuer, NotAfter: metadata.NotAfter, Fingerprint256: metadata.Fingerprint256}
		} else {
			if row.Certificate == nil {
				return mutateResult{}, shared.InvalidRequest("域名访问需要上传公开 CA 证书链和私钥")
			}
			material, err := s.deps.certificates.Read(ctx, row.Certificate.Ref)
			if err != nil {
				return mutateResult{}, err
			}
			// 重读旧材料按新域名重新校验。
			if _, err := ValidateWebsiteCertificate(material, access.Domain, s.deps.trustedRoots, time.Now()); err != nil {
				return mutateResult{}, err
			}
			certificate = row.Certificate
		}
	}
	changingMode := row.AccessMode != access.Mode
	updated := copyRecord(*row)
	updated.AccessMode = access.Mode
	if domain == "" {
		updated.Domain = nil
	} else {
		updated.Domain = stringPtr(domain)
	}
	updated.Certificate = certificate
	// 无变化短路：模式未变、域名未变、未 staged 新证书 → 直接返回现有投影。
	rowHasDomain := row.Domain != nil
	sameDomain := (rowHasDomain && *row.Domain == domain) || (!rowHasDomain && domain == "")
	if !changingMode && sameDomain && stagedRef == "" {
		project, err := s.projectRow(ctx, *row, s.currentConfigOrNull(ctx))
		if err != nil {
			return mutateResult{}, err
		}
		return mutateResult{Project: project, FirewallPort: nil}, nil
	}

	var previousRaw json.RawMessage
	var nextConfig any
	caddyLoaded := false
	newContainerID := ""
	oldStopped := false
	registryChanged := false
	runErr := func() error {
		oldRunning := false
		if row.ContainerID != nil {
			info, err := s.deps.docker.Inspect(ctx, *row.ContainerID)
			if err != nil {
				return err
			}
			if value, ok := object(info["State"])["Running"].(bool); ok && value {
				oldRunning = true
			}
		}
		if changingMode {
			if row.ImageRef == nil || row.ContainerID == nil {
				return &shared.InvalidRequestError{Status: 409, Message: "站点容器不存在，请删除项目后重建"}
			}
			if err := s.deps.docker.EnsureImage(ctx, *row.ImageRef); err != nil {
				return err
			}
			containerName := s.deps.docker.NewContainerName()
			created, err := s.deps.docker.Create(ctx, containerCreateInput{
				ImageRef:      *row.ImageRef,
				Kind:          row.Kind,
				Version:       versionOrDefault(row.RuntimeVersion),
				ProjectID:     row.ID,
				Port:          row.Port,
				BindSource:    row.RootDir,
				AccessMode:    access.Mode,
				Command:       row.DeployCommand,
				ContainerName: containerName,
			})
			if err != nil {
				return err
			}
			newContainerID = created
			updated.ContainerID = stringPtr(created)
			updated.ContainerName = stringPtr(containerName)
			if oldRunning {
				if err := s.deps.docker.Stop(ctx, *row.ContainerID); err != nil {
					return err
				}
				oldStopped = true
				if err := s.deps.docker.Start(ctx, created); err != nil {
					return err
				}
			}
		}
		if row.Domain != nil || domain != "" {
			currentRaw, cerr := s.deps.caddy.CurrentConfig(ctx)
			if cerr != nil {
				return cerr
			}
			previousRaw = json.RawMessage(currentRaw)
			if HasForeignConfig(parseJSONValue(currentRaw), expectedProxyHosts(rows), s.deps.caddy.AdminListen()) {
				return &shared.InvalidRequestError{Status: 409, Message: "宿主 Caddy 存在面板外的配置，拒绝覆盖"}
			}
			projected := make([]WebsiteRecord, len(rows))
			for i, item := range rows {
				if item.ID == id {
					projected[i] = updated
				} else {
					projected[i] = item
				}
			}
			sites, serr := s.sitesWithCertificates(ctx, projected)
			if serr != nil {
				return serr
			}
			configBytes := BuildCaddyConfig(sites, s.deps.caddy.AdminListen())
			nextConfig = parseJSONValue(configBytes)
			if lerr := s.deps.caddy.Load(ctx, configBytes); lerr != nil {
				return lerr
			}
			caddyLoaded = true
		}
		if err := s.deps.registry.Put(ctx, updated); err != nil {
			return err
		}
		registryChanged = true
		if changingMode && row.ContainerID != nil {
			if _, err := s.deps.docker.RemoveManaged(ctx, containerIdentity{
				ContainerID:     *row.ContainerID,
				ContainerName:   stringOrEmpty(row.ContainerName),
				ProjectID:       row.ID,
				Kind:            row.Kind,
				Version:         versionOrDefault(row.RuntimeVersion),
				ImageRef:        stringOrEmpty(row.ImageRef),
				RootDir:         row.RootDir,
				SelfContainerID: s.deps.selfContainerID,
			}); err != nil {
				return err
			}
		}
		if row.Certificate != nil && (certificate == nil || row.Certificate.Ref != certificate.Ref) {
			if err := s.deps.certificates.Remove(ctx, row.Certificate.Ref); err != nil {
				return err
			}
		}
		return nil
	}()
	if runErr != nil {
		var failures []string
		if registryChanged {
			if err := s.deps.registry.Put(ctx, *row); err != nil {
				failures = append(failures, "登记")
			}
		}
		if caddyLoaded && len(previousRaw) > 0 {
			if err := s.deps.caddy.Load(ctx, previousRaw); err != nil {
				failures = append(failures, "Caddy 配置")
			}
		}
		if newContainerID != "" {
			_ = s.deps.docker.Stop(ctx, newContainerID)
			if err := s.deps.docker.RemoveCreated(ctx, newContainerID); err != nil {
				failures = append(failures, "新容器")
			}
		}
		if oldStopped && row.ContainerID != nil {
			if err := s.deps.docker.Start(ctx, *row.ContainerID); err != nil {
				failures = append(failures, "原容器")
			}
		}
		if stagedRef != "" {
			_ = s.deps.certificates.Remove(ctx, stagedRef)
		}
		message := fmt.Sprintf("访问配置保存失败：%s", runErr.Error())
		if len(failures) > 0 {
			message += "；" + strings.Join(failures, "、") + "恢复失败，配置可能不同步，请检查后重新对账"
		} else {
			message += "；原访问配置已恢复"
		}
		return mutateResult{}, errors.New(message)
	}

	configForProject := nextConfig
	if configForProject == nil {
		configForProject = s.currentConfigOrNull(ctx)
	}
	project, err := s.projectRow(ctx, updated, configForProject)
	if err != nil {
		return mutateResult{}, err
	}
	// 切换为直连：端口新发布到 0.0.0.0，与创建同口径自动开放；失败不回滚切换。
	var firewallPort *contract.FirewallPortSync
	if changingMode && access.Mode == AccessModeDirect {
		synced := s.deps.openFirewallPort(ctx, row.Port, "Elysian 网站 "+row.Name)
		firewallPort = &synced
	}
	return mutateResult{Project: project, FirewallPort: firewallPort}, nil
}

// SetRunning 启停：start 已运行容器引擎回 304 视为成功；容器已被外部删除 →
// 404「站点容器已不存在，请删除站点后重建」。
func (s *websiteService) SetRunning(ctx context.Context, id string, running bool) (websiteProject, error) {
	if s.inProgress.has(id) {
		return websiteProject{}, &shared.InvalidRequestError{Status: 409, Message: "项目正在执行其他操作"}
	}
	s.inProgress.add(id)
	defer s.inProgress.remove(id)

	row, err := s.record(ctx, id)
	if err != nil {
		return websiteProject{}, err
	}
	if row.ContainerID == nil {
		return websiteProject{}, &shared.InvalidRequestError{Status: 409, Message: "站点没有容器"}
	}
	var opErr error
	if running {
		opErr = s.deps.docker.Start(ctx, *row.ContainerID)
	} else {
		opErr = s.deps.docker.Stop(ctx, *row.ContainerID)
	}
	if opErr != nil {
		var invalid *shared.InvalidRequestError
		if errors.As(opErr, &invalid) && invalid.Status == 404 {
			return websiteProject{}, &shared.InvalidRequestError{Status: 404, Message: "站点容器已不存在，请删除站点后重建"}
		}
		return websiteProject{}, opErr
	}
	return s.projectRow(ctx, row, s.currentConfigOrNull(ctx))
}

// Logs 容器日志行。
func (s *websiteService) Logs(ctx context.Context, id string) ([]string, error) {
	row, err := s.record(ctx, id)
	if err != nil {
		return nil, err
	}
	if row.ContainerID == nil {
		return nil, &shared.InvalidRequestError{Status: 409, Message: "站点没有容器"}
	}
	lines, err := s.deps.docker.Logs(ctx, *row.ContainerID)
	if err != nil {
		var invalid *shared.InvalidRequestError
		if errors.As(err, &invalid) && invalid.Status == 404 {
			return nil, &shared.InvalidRequestError{Status: 404, Message: "站点容器已不存在，请删除站点后重建"}
		}
		return nil, err
	}
	return lines, nil
}

// Remove 删除：容器 stop（外部已删吞掉）→ Caddy 路由回收与登记删除同处下发队列
// （避免并发创建重新带回旧路由）→ 五重核对删容器 → 删站点目录 → 登记与证书清理。
// Caddy 回收失败不阻断删除，最后抛「配置残留将在下次下发时回收」；目录删除失败
// 同样最后抛。
func (s *websiteService) Remove(ctx context.Context, id string) error {
	if s.inProgress.has(id) || s.inProgress.has(createMutexKey) {
		return &shared.InvalidRequestError{Status: 409, Message: "项目正在执行其他操作"}
	}
	s.inProgress.add(id)
	s.inProgress.add(createMutexKey)
	defer func() {
		s.inProgress.remove(id)
		s.inProgress.remove(createMutexKey)
	}()

	opCtx := context.WithoutCancel(ctx)
	var runErr error
	s.queue.run(func() {
		runErr = s.removeQueued(opCtx, id)
	})
	return runErr
}

// removeQueued 删除的队列内主体。
func (s *websiteService) removeQueued(ctx context.Context, id string) error {
	row, err := s.record(ctx, id)
	if err != nil {
		return err
	}
	if row.ContainerID != nil {
		if err := s.deps.docker.Stop(ctx, *row.ContainerID); err != nil {
			var invalid *shared.InvalidRequestError
			if !errors.As(err, &invalid) || invalid.Status != 404 {
				return err
			}
		}
	}
	// Caddy 路由回收与登记删除同处下发队列：以删除前全部登记域名为已知集合，
	// 推导其余行的期望配置并整配置替换。
	caddyFailure := ""
	rows, listErr := s.deps.registry.List(ctx)
	if listErr != nil {
		caddyFailure = fmt.Sprintf("反向代理配置回收失败：%s；站点资源已删除，配置残留将在下次下发时回收", listErr.Error())
	} else {
		remaining := make([]WebsiteRecord, 0, len(rows))
		for _, item := range rows {
			if item.ID != id {
				remaining = append(remaining, item)
			}
		}
		if _, err := s.pushCaddyConfig(ctx, remaining, expectedProxyHosts(rows)); err != nil {
			caddyFailure = fmt.Sprintf("反向代理配置回收失败：%s；站点资源已删除，配置残留将在下次下发时回收", err.Error())
		}
	}
	if row.ContainerID != nil {
		// 容器已被外部删除时 removeManaged 幂等跳过容器删除，其余步骤照常。
		if _, err := s.deps.docker.RemoveManaged(ctx, containerIdentity{
			ContainerID:     *row.ContainerID,
			ContainerName:   stringOrEmpty(row.ContainerName),
			ProjectID:       row.ID,
			Kind:            row.Kind,
			Version:         versionOrDefault(row.RuntimeVersion),
			ImageRef:        stringOrEmpty(row.ImageRef),
			RootDir:         row.RootDir,
			SelfContainerID: s.deps.selfContainerID,
		}); err != nil {
			return err
		}
	}
	dirFailure := ""
	if err := s.deps.docker.RemoveSiteDir(row.RootDir, s.deps.mountRoot); err != nil {
		dirFailure = fmt.Sprintf("站点目录删除失败：%s", err.Error())
	}
	if err := s.deps.registry.Remove(ctx, id); err != nil {
		return err
	}
	if row.Certificate != nil {
		if err := s.deps.certificates.Remove(ctx, row.Certificate.Ref); err != nil {
			return err
		}
	}
	if caddyFailure != "" {
		return errors.New(caddyFailure)
	}
	if dirFailure != "" {
		return errors.New(dirFailure)
	}
	return nil
}

// ReconcileProxy 域级对账：走同一条下发队列从 registry 全量重新生成并下发，返回
// 下发后的代理状态。下发未应用（通道不可用）→ unavailable；复核读取失败不推翻
// 下发事实（/load 2xx 即整配置生效）→ active + null。
func (s *websiteService) ReconcileProxy(ctx context.Context) (websiteProxyStatus, error) {
	opCtx := context.WithoutCancel(ctx)
	var pushed caddyPushResult
	var pushErr error
	s.queue.run(func() {
		rows, err := s.deps.registry.List(opCtx)
		if err != nil {
			pushErr = err
			return
		}
		pushed, pushErr = s.pushCaddyConfig(opCtx, rows, nil)
	})
	if pushErr != nil {
		return websiteProxyStatus{}, pushErr
	}
	if !pushed.applied {
		return websiteProxyStatus{State: ProxyStateUnavailable, Detail: pushed.detail}, nil
	}
	// /load 已成功（2xx 即整配置生效）；复核读取失败（登记或通道）不推翻下发事实。
	rows, err := s.deps.registry.List(opCtx)
	if err != nil {
		return websiteProxyStatus{State: ProxyStateActive, Detail: nil}, nil
	}
	currentRaw, cerr := s.deps.caddy.CurrentConfig(opCtx)
	if cerr != nil {
		return websiteProxyStatus{State: ProxyStateActive, Detail: nil}, nil
	}
	sites := caddyManagedSites(rows)
	applied := AppliedManagedHosts(sites, parseJSONValue(currentRaw))
	missing := 0
	for host := range expectedProxyHosts(rows) {
		if _, ok := applied[host]; !ok {
			missing++
		}
	}
	if missing > 0 {
		detail := fmt.Sprintf("%d 个站点的路由未下发", missing)
		return websiteProxyStatus{State: ProxyStateActive, Detail: &detail}, nil
	}
	return websiteProxyStatus{State: ProxyStateActive, Detail: nil}, nil
}

// ---------- 小工具 ----------

// versionOrDefault 容器标签版本：runtimeVersion 缺省按 'html'（TS ?? 'html' 等价物）。
func versionOrDefault(version *string) string {
	if version != nil {
		return *version
	}
	return "html"
}

// deployCommandEquals 部署命令相等判定（nil 与 nil 相等）。
func deployCommandEquals(a *string, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

// stringOrEmpty 指针取值（nil 回空串）。
func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// fallbackDetail detail 为 nil 时回退文案（TS `detail ?? fallback` 等价物）。
func fallbackDetail(detail *string, fallback string) string {
	if detail != nil {
		return *detail
	}
	return fallback
}

// isoNowUTC 当前时刻的毫秒精度 ISO 串（与 JS new Date().toISOString() 同形）。
func isoNowUTC() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
