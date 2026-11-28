package database

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"

	"elysian/server/internal/seam"
)

func (d *dockerAPI) agentManaged(ctx context.Context, row databaseRecord, selfID string) (map[string]any, error) {
	if !containerIDPattern.MatchString(row.ContainerID) || !managedVolumeNamePattern.MatchString(row.VolumeName) {
		return nil, errors.New("数据库容器或专属卷标识无效")
	}
	info, err := d.inspect(ctx, row.ContainerID)
	if err != nil {
		return nil, err
	}
	if asString(info["Id"]) != row.ContainerID || seam.IsSelfContainer(selfID, asString(info["Id"])) {
		return nil, errors.New("数据库容器身份核验失败")
	}
	labels := obj(field(obj(field(info, "Config")), "Labels"))
	for key, value := range map[string]string{"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": row.Engine, "elysian.database.version": row.VersionTag, "elysian.database.volume": row.VolumeName} {
		if asString(labels[key]) != value {
			return nil, errors.New("数据库容器受管标签与登记不匹配")
		}
	}
	imageID := stripSha256Prefix(asString(info["Image"]))
	images, err := d.listImages(ctx)
	if err != nil {
		return nil, err
	}
	imageOK := false
	for _, image := range images {
		if stripSha256Prefix(image.ID) == imageID && databaseImageHasTag(image, row.Engine, row.VersionTag) {
			imageOK = true
			break
		}
	}
	if !imageOK {
		return nil, errors.New("数据库容器镜像身份核验失败")
	}
	mounted := false
	if mounts, ok := info["Mounts"].([]any); ok {
		for _, item := range mounts {
			m := obj(item)
			if asString(m["Type"]) == "volume" && asString(m["Name"]) == row.VolumeName {
				mounted = true
			}
		}
	}
	if !mounted {
		return nil, errors.New("数据库专属卷未挂载")
	}
	response, err := d.request(ctx, "GET", "/volumes/"+url.PathEscape(row.VolumeName), nil, nil)
	if err != nil {
		return nil, err
	}
	var volume map[string]any
	if response.Status != 200 || json.Unmarshal(response.Body, &volume) != nil {
		return nil, errors.New("数据库专属卷不可核验")
	}
	volumeLabels := obj(volume["Labels"])
	for key, value := range map[string]string{"elysian.database": "true", "elysian.database.engine": row.Engine, "elysian.database.version": row.VersionTag} {
		if asString(volumeLabels[key]) != value {
			return nil, errors.New("数据库专属卷标签不匹配")
		}
	}
	return info, nil
}

func (d *dockerAPI) agentControl(ctx context.Context, row databaseRecord, action, selfID string) error {
	if action != "start" && action != "stop" {
		return errors.New("容器操作未开放")
	}
	if _, err := d.agentManaged(ctx, row, selfID); err != nil {
		return err
	}
	return d.setContainerRunning(ctx, row.ContainerID, action == "start")
}

// agentAdoptedControl 是接管容器的启停：只核验容器身份与引擎一致（没有面板的五元标签与
// 专属卷可核），动作与回读确认与受管实例共用。
func (d *dockerAPI) agentAdoptedControl(ctx context.Context, row databaseRecord, action, selfID string) error {
	if action != "start" && action != "stop" {
		return errors.New("容器操作未开放")
	}
	info, err := d.inspect(ctx, row.ContainerID)
	if err != nil {
		return err
	}
	id := asString(info["Id"])
	if id != row.ContainerID || seam.IsSelfContainer(selfID, id) {
		return errors.New("数据库容器身份核验失败")
	}
	refName, _ := splitImageRef(inspectImageRef(info))
	if engine := engineFromImage(obj(field(obj(field(info, "Config")), "Labels")), refName); engine != "" && engine != row.Engine {
		return errors.New("容器镜像与登记的数据库引擎不一致")
	}
	return d.setContainerRunning(ctx, row.ContainerID, action == "start")
}

// setContainerRunning 变更容器运行状态并回读确认；状态已一致时幂等返回。
func (d *dockerAPI) setContainerRunning(ctx context.Context, containerID string, running bool) error {
	info, err := d.inspect(ctx, containerID)
	if err != nil {
		return err
	}
	if inspectRunning(info) == running {
		return nil
	}
	action := "stop"
	query := url.Values{}
	if running {
		action = "start"
	} else {
		query.Set("t", "10")
	}
	response, err := d.request(ctx, "POST", "/containers/"+url.PathEscape(containerID)+"/"+action, query, nil)
	if err != nil {
		return err
	}
	if response.Status != 204 && response.Status != 304 {
		return errors.New("数据库容器状态变更失败")
	}
	current, err := d.inspect(ctx, containerID)
	if err != nil || inspectRunning(current) != running {
		return errors.New("数据库容器状态未确认")
	}
	return nil
}
