package websites

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/seam"
)

func recordValue(v any) WebsiteRecord {
	switch r := v.(type) {
	case WebsiteRecord:
		return r
	case *WebsiteRecord:
		if r != nil {
			return *r
		}
	}
	return WebsiteRecord{}
}
func runtimeRecordKind(v any) string {
	r := recordValue(v)
	if r.DeploymentTarget == "static" {
		return KindHTML
	}
	return r.Kind
}
func runtimeRecordDir(v any) string {
	r := recordValue(v)
	if r.CurrentRelease != nil {
		return r.CurrentRelease.Directory
	}
	return r.RootDir
}
func runtimeRecordVersion(v any) string {
	r := recordValue(v)
	if runtimeRecordKind(r) == KindHTML {
		return versionOrDefault(nil)
	}
	return versionOrDefault(r.RuntimeVersion)
}
func syncReleaseRecord(r WebsiteRecord) WebsiteRecord {
	r = copyRecord(r)
	if r.CurrentRelease != nil {
		r.CurrentRelease.ContainerID = stringOrEmpty(r.ContainerID)
		r.CurrentRelease.ContainerName = stringOrEmpty(r.ContainerName)
		r.CurrentRelease.Command = stringOrEmpty(r.DeployCommand)
	}
	return r
}
func recordIdentity(r WebsiteRecord, self string) containerIdentity {
	return containerIdentity{ContainerID: stringOrEmpty(r.ContainerID), ContainerName: stringOrEmpty(r.ContainerName), ProjectID: r.ID, Kind: runtimeRecordKind(r), Version: runtimeRecordVersion(r), ImageRef: stringOrEmpty(r.ImageRef), RootDir: runtimeRecordDir(r), SelfContainerID: self}
}
func releaseAsRecord(r WebsiteRecord, release releaseRecord) WebsiteRecord {
	r = copyRecord(r)
	r.CurrentRelease = &release
	r.DeploymentTarget = release.Target
	r.BuildRuntimeVersion = release.BuildVersion
	r.ContainerID = stringPtr(release.ContainerID)
	r.ContainerName = stringPtr(release.ContainerName)
	r.ImageRef = stringPtr(release.RuntimeImage)
	r.RuntimeVersion = stringPtr(release.RuntimeVersion)
	if release.Target == "static" {
		r.RuntimeVersion = nil
	}
	r.DeployCommand = stringPtr(release.Command)
	return r
}
func (s *websiteService) assertRecordContainer(ctx context.Context, r WebsiteRecord) error {
	if r.ContainerID == nil {
		return nil
	}
	if _, real := s.deps.docker.(*websiteDocker); !real {
		return nil
	}
	info, err := s.deps.docker.Inspect(ctx, *r.ContainerID)
	if err != nil {
		return err
	}
	if seam.IsSelfContainer(s.deps.selfContainerID, *r.ContainerID) {
		return errors.New("站点容器身份核对失败")
	}
	cfg := object(info["Config"])
	labels := object(cfg["Labels"])
	identity := recordIdentity(r, s.deps.selfContainerID)
	if info["Name"] != "/"+identity.ContainerName || cfg["Image"] != identity.ImageRef || labels["elysian.managed"] != "true" || labels["elysian.website"] != "true" || labels["elysian.website.project"] != r.ID || labels["elysian.website.kind"] != identity.Kind || labels["elysian.website.version"] != identity.Version {
		return errors.New("站点容器身份核对失败")
	}
	target := siteAppTarget
	if identity.Kind == KindHTML {
		target = siteHTMLTarget
	}
	mounts, _ := info["Mounts"].([]any)
	for _, v := range mounts {
		m := object(v)
		if m["Type"] == "bind" && m["Source"] == identity.RootDir && m["Destination"] == target {
			return nil
		}
	}
	return errors.New("站点容器挂载身份核对失败")
}
func (m *deploymentManager) publish(ctx context.Context, id, app, artifact string, c projectCandidate) error {
	t, _ := m.getTask(id)
	if t.ProjectID == "" {
		if !m.service.inProgress.acquire(createMutexKey) {
			return errors.New("网站项目正在创建，请重试部署")
		}
		defer m.service.inProgress.remove(createMutexKey)
	}
	var row WebsiteRecord
	var previous *WebsiteRecord
	previousRunning := false
	var err error
	if t.ProjectID != "" {
		r, e := m.service.record(ctx, t.ProjectID)
		if e != nil {
			return e
		}
		if r.Kind != c.Kind {
			return errors.New("重新部署的项目类型必须与原项目一致")
		}
		if err = m.service.assertRecordContainer(ctx, r); err != nil {
			return err
		}
		if r.ContainerID != nil {
			info, e := m.service.deps.docker.Inspect(ctx, *r.ContainerID)
			if e != nil {
				return e
			}
			previousRunning, _ = object(info["State"])["Running"].(bool)
		}
		previous = &r
		row = copyRecord(r)
	} else {
		rows, e := m.service.deps.registry.List(ctx)
		if e != nil {
			return e
		}
		for _, r := range rows {
			if r.Name == t.Name {
				return errors.New("项目名称已存在")
			}
			if r.Domain != nil && *r.Domain == t.Input.Access.Domain {
				return errors.New("域名已被使用")
			}
		}
		if e = m.service.assertPortAvailable(ctx, t.Input.Port, rows); e != nil {
			return e
		}
		root, e := m.service.deps.docker.EnsureSiteDir(t.Name, m.service.deps.mountRoot)
		if e != nil {
			return e
		}
		row = WebsiteRecord{ID: newDeploymentID(), Kind: c.Kind, Name: t.Name, Port: t.Input.Port, RootDir: root, AccessMode: t.Input.Access.Mode, Certificate: t.StagedCertificate, Category: CategoryDevelopment, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
		if t.Input.Access.Mode == "domain" {
			row.Domain = stringPtr(t.Input.Access.Domain)
		}
		src, _ := m.getSource(t.SourceID)
		if src.GitURL != "" {
			row.GitURL = stringPtr(src.GitURL)
		}
	}
	resolvedRoot, rootErr := filepath.EvalSymlinks(row.RootDir)
	if rootErr != nil || resolvedRoot != row.RootDir {
		return errors.New("项目根目录身份已改变，无法发布")
	}
	// 版本目录不能包含宿主链接；目录创建与复制均在项目专属根之下。
	releases := filepath.Join(row.RootDir, ".releases")
	if _, err = os.Lstat(releases); err == nil {
		info, e := os.Lstat(releases)
		if e != nil || !info.IsDir() {
			return errors.New("发布目录不可信")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	releaseDir := filepath.Join(releases, id, "app")
	if _, err = os.Lstat(filepath.Dir(releaseDir)); err == nil {
		return errors.New("发布版本目录已存在")
	}
	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(filepath.Dir(releaseDir))
		}
	}()
	if err = m.prepareRelease(ctx, app, artifact, releaseDir, c, t.Config); err != nil {
		return err
	}
	src, _ := m.getSource(t.SourceID)
	row.GitURL = nil
	if src.GitURL != "" {
		row.GitURL = stringPtr(src.GitURL)
	}
	release := releaseRecord{ID: id, CreatedAt: time.Now().UTC().Format(time.RFC3339), SourceID: t.SourceID, Commit: src.Commit, Directory: releaseDir, Target: t.Config.Target, BuildImage: t.BuildImage, RuntimeImage: t.RuntimeImage, BuildVersion: t.Config.BuildVersion, RuntimeVersion: t.Config.RuntimeVersion, Command: t.Config.Command}
	row.CurrentRelease = &release
	row.DeploymentTarget = t.Config.Target
	row.BuildRuntimeVersion = t.Config.BuildVersion
	row.RuntimeVersion = stringPtr(t.Config.RuntimeVersion)
	if row.DeploymentTarget == "static" {
		row.RuntimeVersion = nil
		row.CurrentRelease.RuntimeVersion = ""
	}
	row.ImageRef = stringPtr(t.RuntimeImage)
	row.DeployCommand = stringPtr(t.Config.Command)
	row.Note = t.Input.Note
	row.Enabled = true
	if previous != nil {
		if previous.CurrentRelease != nil {
			old := *previous.CurrentRelease
			row.PreviousRelease = &old
		} else {
			row.PreviousRelease = &releaseRecord{ID: newDeploymentID(), CreatedAt: previous.CreatedAt, Directory: previous.RootDir, Target: map[bool]string{true: "static", false: "service"}[previous.Kind == KindHTML], RuntimeImage: stringOrEmpty(previous.ImageRef), RuntimeVersion: stringOrEmpty(previous.RuntimeVersion), Command: stringOrEmpty(previous.DeployCommand), ContainerID: stringOrEmpty(previous.ContainerID), ContainerName: stringOrEmpty(previous.ContainerName)}
		}
	}
	name := m.service.deps.docker.NewContainerName()
	container, err := m.service.deps.docker.Create(ctx, containerCreateInput{ImageRef: t.RuntimeImage, Kind: runtimeRecordKind(row), Version: runtimeRecordVersion(row), ProjectID: row.ID, Port: row.Port, BindSource: releaseDir, AccessMode: row.AccessMode, Command: row.DeployCommand, ContainerName: name})
	if err != nil {
		return err
	}
	row.ContainerID = stringPtr(container)
	row.ContainerName = stringPtr(name)
	row = syncReleaseRecord(row)
	if err = m.mutate(id, func(t *deploymentTask) {
		t.State = "publishing"
		t.Stage = "切换容器并检查内部端口"
		t.Previous = previous
		t.PreviousRunning = previousRunning
		t.Pending = &row
		t.ProjectID = row.ID
	}); err != nil {
		_ = m.service.deps.docker.RemoveCreated(context.WithoutCancel(ctx), container)
		return err
	}
	// 与访问配置、删除的整配置下发共用串行队列。
	m.service.queue.run(func() {
		if previous != nil && previous.ContainerID != nil {
			err = m.service.deps.docker.Stop(ctx, *previous.ContainerID)
		}
		if err == nil {
			err = m.service.deps.docker.Start(ctx, container)
		}
		if err == nil {
			err = m.ready(ctx, row, id)
		}
		if err == nil {
			err = m.service.deps.registry.Put(ctx, row)
		}
		if err == nil && row.Domain != nil {
			rows, e := m.service.deps.registry.List(ctx)
			if e != nil {
				err = e
			} else {
				_, err = m.service.pushCaddyConfig(ctx, rows, expectedProxyHosts(rows))
			}
		}
		if err != nil {
			restoreCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			latest, _ := m.getTask(id)
			if e := m.restoreInterrupted(restoreCtx, &latest); e != nil {
				err = fmt.Errorf("%w；恢复上一版本失败，需要处理：%s", err, e.Error())
			} else if e := m.mutate(id, func(t *deploymentTask) { t.Pending, t.Previous = nil, nil }); e != nil {
				err = errors.Join(err, e)
			}
		}
	})
	if err != nil {
		return err
	}
	if row.AccessMode == AccessModeDirect {
		sync := m.service.deps.openFirewallPort(context.WithoutCancel(ctx), row.Port, "Elysian 网站 "+row.Name)
		m.log(id, fmt.Sprintf("直连端口同步状态：%s", sync.State))
	}
	if err = m.mutate(id, func(t *deploymentTask) { t.Release = row.CurrentRelease; t.Pending = nil; t.Previous = nil }); err != nil {
		return err
	}
	if previous != nil && previous.PreviousRelease != nil {
		retired := releaseAsRecord(*previous, *previous.PreviousRelease)
		if _, e := m.service.deps.docker.RemoveManaged(ctx, recordIdentity(retired, m.service.deps.selfContainerID)); e != nil {
			m.log(id, "旧版本容器清理需要处理："+e.Error())
		} else if strings.HasPrefix(retired.CurrentRelease.Directory, releases+string(filepath.Separator)) {
			_ = os.RemoveAll(filepath.Dir(retired.CurrentRelease.Directory))
		}
	}
	published = true
	return nil
}
func (m *deploymentManager) prepareRelease(ctx context.Context, app, artifact, dest string, c projectCandidate, cfg buildConfig) error {
	src, err := archivePath(app, artifact)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDeploymentTree(ctx, src, dest)
	}
	if err = os.MkdirAll(dest, 0755); err != nil {
		return err
	}
	target := filepath.Base(src)
	if c.Kind == KindJava && strings.HasSuffix(src, ".jar") {
		target = "app.jar"
	}
	if c.Kind == KindGo {
		target = "server"
	}
	if err = copySingleFile(ctx, src, filepath.Join(dest, target)); err != nil {
		return err
	}
	if c.Kind == KindGo {
		err = os.Chmod(filepath.Join(dest, target), 0755)
	}
	if c.Kind == KindJava {
		for _, dir := range []string{filepath.Join(filepath.Dir(src), "dependencies"), filepath.Join(app, "lib")} {
			if stat, e := os.Stat(dir); e == nil && stat.IsDir() {
				if err = copyDeploymentTree(ctx, dir, filepath.Join(dest, "lib")); err != nil {
					return err
				}
			}
		}
	}
	return err
}
func copySingleFile(ctx context.Context, src, dest string) error {
	tmp, err := os.MkdirTemp(filepath.Dir(dest), ".copy-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, err = io.Copy(out, contextReader{ctx, in})
	ce := out.Close()
	if err != nil {
		return err
	}
	return ce
}
func (m *deploymentManager) ready(ctx context.Context, row WebsiteRecord, taskID string) (result error) {
	port := row.Port
	if runtimeRecordKind(row) == KindHTML {
		port = 80
	}
	if err := m.engine.pull(ctx, WEBSITE_HTML_IMAGE); err != nil {
		return err
	}
	body := map[string]any{"Image": WEBSITE_HTML_IMAGE, "User": "65532:65532", "Cmd": []string{"sh", "-c", fmt.Sprintf("addr=$(ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1); for i in $(seq 1 60); do if nc -w 1 $addr %d </dev/null; then exit 0; fi; sleep 1; done; exit 1", port)}, "Entrypoint": []string{}, "Labels": map[string]string{"elysian.managed": "true", "elysian.website.probe": "true", "elysian.website.deployment-owner": m.engine.owner}, "HostConfig": map[string]any{"NetworkMode": "container:" + stringOrEmpty(row.ContainerID), "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "Memory": 64 << 20, "PidsLimit": 64}}
	out, err := m.engine.json(ctx, "POST", "/containers/create", body)
	if err != nil {
		return err
	}
	id, _ := out["Id"].(string)
	if !containerIDPattern.MatchString(id) {
		return errors.New("探测容器 ID 无效")
	}
	if err = m.trackAuxContainer(taskID, id); err != nil {
		_ = m.engine.remove(id)
		return err
	}
	defer func() {
		if err := m.removeTaskContainer(taskID, id); err != nil {
			result = errors.Join(result, err)
		}
	}()
	probeCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	if err = m.engine.run(probeCtx, id, io.Discard); err != nil {
		return fmt.Errorf("内部端口 %d 未就绪：%w", port, err)
	}
	return nil
}
func (m *deploymentManager) restoreInterrupted(ctx context.Context, t *deploymentTask) error {
	if t.Pending == nil {
		return nil
	}
	if t.Pending.ContainerID != nil {
		if err := m.service.assertRecordContainer(ctx, *t.Pending); err != nil {
			return err
		}
		if _, err := m.service.deps.docker.RemoveManaged(ctx, recordIdentity(*t.Pending, m.service.deps.selfContainerID)); err != nil {
			return err
		}
	}
	if t.Previous != nil {
		if err := m.service.assertRecordContainer(ctx, *t.Previous); err != nil {
			return err
		}
		if t.Previous.ContainerID != nil && t.PreviousRunning {
			if err := m.service.deps.docker.Start(ctx, *t.Previous.ContainerID); err != nil {
				return err
			}
		}
		if err := m.service.deps.registry.Put(ctx, *t.Previous); err != nil {
			return err
		}
	} else {
		if err := m.service.deps.registry.Remove(ctx, t.Pending.ID); err != nil {
			return err
		}
	}
	if t.Pending.CurrentRelease != nil && t.Pending.CurrentRelease.ID == t.ID && strings.HasPrefix(t.Pending.CurrentRelease.Directory, filepath.Join(t.Pending.RootDir, ".releases")+string(filepath.Separator)) {
		_ = os.RemoveAll(filepath.Dir(t.Pending.CurrentRelease.Directory))
	}
	rows, err := m.service.deps.registry.List(ctx)
	if err != nil {
		return err
	}
	if t.Pending.Domain != nil {
		_, err = m.service.pushCaddyConfig(ctx, rows, expectedProxyHosts(append(rows, *t.Pending)))
	}
	return err
}
