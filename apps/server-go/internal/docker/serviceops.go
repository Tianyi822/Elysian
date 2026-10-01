package docker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 容器动作 / 创建 / 拉取 / 删除（dockerService.ts runAction / runRemove / create /
// pull / removeImage 逐字移植）。

// tryLockAction 按请求 id 记账加锁：同 id 已有动作在途 → 409「该容器正在执行其他操作」。
func (s *dockerService) tryLockAction(id string) (func(), error) {
	s.actionMu.Lock()
	defer s.actionMu.Unlock()
	if _, busy := s.actionLocks[id]; busy {
		return nil, &shared.InvalidRequestError{Status: http.StatusConflict, Message: actionBusyMessage}
	}
	s.actionLocks[id] = struct{}{}
	var once sync.Once
	return func() {
		once.Do(func() {
			s.actionMu.Lock()
			delete(s.actionLocks, id)
			s.actionMu.Unlock()
		})
	}, nil
}

// Action start/stop/restart：inspect 自检 → paused 拦截 →（restart 先推 restarting
// 事件，必须在 Engine 动作之前）→ Engine 动作（304 视为成功）→ inspect 回读。
func (s *dockerService) Action(ctx context.Context, id, action string) (contract.Container, error) {
	release, err := s.tryLockAction(id)
	if err != nil {
		return contract.Container{}, err
	}
	defer release()

	// 自我保护以 inspect 解析出的完整 Id 为准：容器名、前缀等寻址形态解析后
	// 都归一到同一 Id，按名寻址不再绕过守卫。
	preInspect, err := s.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if (action == "stop" || action == "restart") && selfInspectCheck(preInspect, s.deps.selfContainerID) {
		return contract.Container{}, &shared.InvalidRequestError{Status: http.StatusBadRequest, Message: actionSelfMessage}
	}
	if isPausedInspect(preInspect) {
		return contract.Container{}, &shared.InvalidRequestError{Status: http.StatusConflict, Message: actionPausedMessage}
	}

	if action == "restart" && s.deps.onRestarting != nil {
		s.deps.onRestarting(id)
	}

	var query url.Values
	actionPath := "/containers/" + encodeEngineID(id) + "/" + action
	if action == "stop" {
		query = url.Values{"t": {"10"}}
	}
	status, _, err := s.engineJSON(ctx, http.MethodPost, actionPath, query, nil, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if status == http.StatusNotFound {
		return contract.Container{}, &shared.InvalidRequestError{Status: http.StatusNotFound, Message: containerNotFoundMessage}
	}
	if status != http.StatusOK && status != http.StatusNoContent && status != http.StatusNotModified {
		return contract.Container{}, fmt.Errorf("容器%s失败（HTTP %d）", action, status)
	}

	postInspect, err := s.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	return mapContainer(postInspect)
}

// RemoveContainer 删除容器：inspect 解析后先过自我保护与数据库 label 保护，
// 不带 force——引擎对运行中容器返回 409。
func (s *dockerService) RemoveContainer(ctx context.Context, id string) error {
	release, err := s.tryLockAction(id)
	if err != nil {
		return err
	}
	defer release()

	inspect, err := s.inspectContainerByID(ctx, id, actionTimeout)
	if err != nil {
		return err
	}
	if selfInspectCheck(inspect, s.deps.selfContainerID) {
		return &shared.InvalidRequestError{Status: http.StatusBadRequest, Message: actionSelfMessage}
	}
	if record, ok := asRecord(inspect); ok {
		if config, ok := asRecord(mustGet(record, "Config")); ok {
			if labels, ok := asRecord(mustGet(config, "Labels")); ok {
				if value, ok := asString(mustGet(labels, labelDatabase)); ok && value == labelTrueValue {
					return &shared.InvalidRequestError{Status: http.StatusConflict, Message: "数据库容器须在数据库页使用“删除容器及数据”操作"}
				}
			}
		}
	}
	targetID, err := requireID(inspect, "容器")
	if err != nil {
		return err
	}
	status, value, err := s.engineJSON(ctx, http.MethodDelete, "/containers/"+encodeEngineID(targetID), nil, nil, actionTimeout)
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		return &shared.InvalidRequestError{Status: http.StatusNotFound, Message: containerNotFoundMessage}
	}
	if status == http.StatusConflict {
		return &shared.InvalidRequestError{Status: http.StatusConflict, Message: containerRunningRemoveMessage}
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		return fmt.Errorf("容器删除失败（HTTP %d）：%s", status, engineErrorMessage(value, "未知错误"))
	}
	return nil
}

// Create 创建并启动容器：全局串行 → 并发列表 → buildCreateSpec → 逐级 mkdir →
// create → start（失败撤销，撤销也失败时附容器 ID）→ inspect。
func (s *dockerService) Create(ctx context.Context, body any) (contract.Container, error) {
	s.createMu.Lock()
	defer s.createMu.Unlock()

	containersValues, err := s.listWithInspect(ctx, "/containers/json", url.Values{"all": {"1"}},
		func(id string) string { return "/containers/" + encodeEngineID(id) + "/json" },
		"容器",
		func(_, inspect any) (any, error) { return mapContainer(inspect) })
	if err != nil {
		return contract.Container{}, err
	}
	images, err := s.imagesFromList(ctx)
	if err != nil {
		return contract.Container{}, err
	}

	containers := make([]containerBrief, 0, len(containersValues))
	for _, value := range containersValues {
		container, ok := value.(contract.Container)
		if !ok {
			return contract.Container{}, errors.New("容器详情格式无效：根对象必须是对象")
		}
		brief := containerBrief{name: container.Name}
		for _, port := range container.Ports {
			brief.ports = append(brief.ports, portBrief{hostPort: port.HostPort, protocol: port.Protocol, hostIP: port.HostIP})
		}
		containers = append(containers, brief)
	}
	imageBriefs := make([]imageBrief, 0, len(images))
	for _, image := range images {
		imageBriefs = append(imageBriefs, imageBrief{id: image.ID, name: image.Name})
	}

	spec, err := buildCreateSpec(buildCreateSpecInput{
		body:          body,
		images:        imageBriefs,
		containers:    containers,
		mountRoot:     s.deps.mountRoot,
		reservedPorts: s.deps.reservedPorts,
		realpath:      s.deps.realpath,
	})
	if err != nil {
		return contract.Container{}, err
	}

	for _, dir := range spec.mkdirPaths {
		if err := s.deps.mkdir(dir, 0o755); err != nil {
			return contract.Container{}, err
		}
	}

	createStatus, createValue, err := s.engineJSON(ctx, http.MethodPost, "/containers/create", url.Values{"name": {spec.name}}, spec.createBody, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if createStatus < 200 || createStatus >= 300 {
		return contract.Container{}, fmt.Errorf("创建容器失败（HTTP %d）：%s", createStatus, engineErrorMessage(createValue, "未知错误"))
	}

	containerID, err := requireCreateID(createValue)
	if err != nil {
		return contract.Container{}, err
	}

	startStatus, startValue, err := s.engineJSON(ctx, http.MethodPost, "/containers/"+encodeEngineID(containerID)+"/start", nil, nil, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	if startStatus != http.StatusOK && startStatus != http.StatusNoContent && startStatus != http.StatusNotModified {
		reason := engineErrorMessage(startValue, fmt.Sprintf("HTTP %d", startStatus))
		deleteStatus, _, deleteErr := s.engineJSON(ctx, http.MethodDelete, "/containers/"+encodeEngineID(containerID), nil, nil, actionTimeout)
		deleted := deleteErr == nil && (deleteStatus == http.StatusOK || deleteStatus == http.StatusNoContent || deleteStatus == http.StatusNotFound)
		message := fmt.Sprintf("容器启动失败，已撤销创建：%s", reason)
		if !deleted {
			message += fmt.Sprintf("且撤销失败，容器 ID 为 %s", containerID)
		}
		return contract.Container{}, &shared.InvalidRequestError{Status: http.StatusBadRequest, Message: message}
	}

	inspect, err := s.inspectContainerByID(ctx, containerID, actionTimeout)
	if err != nil {
		return contract.Container{}, err
	}
	return mapContainer(inspect)
}

// Pull 拉取镜像：单飞 → 已存在拒 → 镜像源校验（内嵌/显式互斥）→ Engine 拉取
// （流式，客户端断开即取消）→ 自定义源打标签并删源标签 → 回查本地镜像。
func (s *dockerService) Pull(ctx context.Context, body any, onProgress func(imagePullProgress)) (contract.ContainerImage, error) {
	if !s.pullInFlight.CompareAndSwap(false, true) {
		return contract.ContainerImage{}, &shared.InvalidRequestError{Status: http.StatusConflict, Message: pullBusyMessage}
	}
	defer s.pullInFlight.Store(false)

	input, err := parsePullBody(body)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	embeddedHost, hasEmbedded := embeddedRegistryHost(input.name)
	if hasEmbedded && input.hasRegistry {
		return contract.ContainerImage{}, shared.InvalidRequest(registryReferenceConflictMsg)
	}

	exists, err := s.imageExistsByTag(ctx, input.name, input.tag)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	if exists {
		return contract.ContainerImage{}, shared.InvalidRequest(fmt.Sprintf("镜像已存在：%s:%s", input.name, input.tag))
	}

	fromImage := fmt.Sprintf("%s:%s", input.name, input.tag)
	registryPullRef := ""
	if input.hasRegistry {
		registryHost, err := s.assertRegistryAllowed(ctx, input.registry)
		if err != nil {
			return contract.ContainerImage{}, err
		}
		fromImage = buildRegistryFromImage(registryHost, input.name, input.tag)
		registryPullRef = fromImage
	} else if hasEmbedded {
		if _, err := s.assertRegistryAllowed(ctx, embeddedHost); err != nil {
			return contract.ContainerImage{}, err
		}
	}

	// 流式解码：onChunk 无错误回传通道，首个解码错误在流结束后以 400 收口
	//（TS 在行内即时失败；引擎在 error 行后即收流，可观察结果一致）。
	var decoder *pullProgressDecoder
	var decoderErr error
	var onChunk func([]byte)
	if onProgress != nil {
		decoder = newPullProgressDecoder(onProgress)
		onChunk = func(chunk []byte) {
			if decoderErr != nil {
				return
			}
			if err := decoder.feed(chunk); err != nil {
				decoderErr = err
			}
		}
	}
	response, err := s.deps.transport.Stream(ctx, seam.EngineRequest{
		Method:   http.MethodPost,
		Path:     "/images/create",
		Query:    url.Values{"fromImage": {fromImage}},
		Timeout:  pullTimeout,
		MaxBytes: pullProgressMaxBytes,
	}, onChunk)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	if decoderErr != nil {
		return contract.ContainerImage{}, shared.InvalidRequest(decoderErr.Error())
	}
	if response.Status != http.StatusOK {
		return contract.ContainerImage{}, fmt.Errorf("拉取镜像失败（HTTP %d）", response.Status)
	}
	if err := readPullProgress(response.Body); err != nil {
		return contract.ContainerImage{}, shared.InvalidRequest(err.Error())
	}
	if decoder != nil {
		if err := decoder.finish(); err != nil {
			return contract.ContainerImage{}, shared.InvalidRequest(err.Error())
		}
	}

	if registryPullRef != "" {
		if err := s.tagImageRef(ctx, registryPullRef, input.name, input.tag); err != nil {
			return contract.ContainerImage{}, err
		}
		untag, err := s.deleteImageRef(ctx, registryPullRef)
		if err != nil {
			return contract.ContainerImage{}, err
		}
		if untag.message != "" {
			return contract.ContainerImage{}, shared.InvalidRequest("拉取后清理镜像源标签失败：" + untag.message)
		}
	}

	images, err := s.imagesFromList(ctx)
	if err != nil {
		return contract.ContainerImage{}, err
	}
	for _, image := range images {
		if image.Name == input.name && image.Tag == input.tag {
			return image, nil
		}
	}
	return contract.ContainerImage{}, errors.New("拉取完成但未找到本地镜像")
}

// RemoveImage 删除镜像：引用计数 → 详情 → 无 RepoTags 按 ID 删，有则按字典序
// 逐个删（中途失败的消息含首个已删标签）。
func (s *dockerService) RemoveImage(ctx context.Context, id string) error {
	normalizedID := normalizeImageID(strings.TrimSpace(id))
	if normalizedID == "" {
		return shared.InvalidRequest("镜像 ID 不能为空")
	}

	refs, err := s.countContainerImageReferences(ctx, normalizedID)
	if err != nil {
		return err
	}
	if refs > 0 {
		return &shared.InvalidRequestError{Status: http.StatusConflict, Message: imageInUseMessage}
	}

	inspect, err := s.inspectImageByID(ctx, normalizedID)
	if err != nil {
		return err
	}
	repoTags := []string{}
	if record, ok := asRecord(inspect); ok {
		if rawTags, ok := asArray(mustGet(record, "RepoTags")); ok {
			for _, tag := range rawTags {
				if tagStr, ok := asString(tag); ok && tagStr != "" {
					repoTags = append(repoTags, tagStr)
				}
			}
		}
	}

	if len(repoTags) == 0 {
		result, err := s.deleteImageRef(ctx, normalizedID)
		if err != nil {
			return err
		}
		if result.message != "" {
			return shared.InvalidRequest("删除镜像失败：" + result.message)
		}
		return nil
	}

	sorted := append([]string(nil), repoTags...)
	sort.SliceStable(sorted, func(i, j int) bool { return repoTagCompare(sorted[i], sorted[j]) })
	removed := []string{}
	for _, tag := range sorted {
		result, err := s.deleteImageRef(ctx, tag)
		if err != nil {
			return err
		}
		if result.message != "" {
			removedHint := ""
			if len(removed) > 0 {
				removedHint = "已移除 " + removed[0] + "，"
			}
			return shared.InvalidRequest(removedHint + "删除 " + tag + " 失败：" + result.message)
		}
		removed = append(removed, tag)
	}
	return nil
}
