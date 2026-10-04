package websites

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

func decodeDeployment(w http.ResponseWriter, r *http.Request, v any) error {
	body, err := middleware.ReadJSONBody(w, r, 256<<10)
	if err != nil {
		return err
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if json.Unmarshal(b, v) != nil {
		return shared.InvalidRequest("部署请求格式无效")
	}
	return nil
}
func mountDeploymentRoutes(r chi.Router, m *deploymentManager) {
	r.Post("/sources/archive", func(w http.ResponseWriter, r *http.Request) {
		mode := r.URL.Query().Get("mode")
		if mode == "" {
			mode = "source"
		}
		r.Body = http.MaxBytesReader(w, r.Body, m.engine.limits.ArchiveBytes+1)
		name, _ := url.QueryUnescape(r.Header.Get("X-File-Name"))
		src, err := m.archive(r.Context(), name, mode, r.Body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 201, src)
	})
	r.Post("/sources/git", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL   string `json:"url"`
			Ref   string `json:"ref"`
			Token string `json:"token"`
			Mode  string `json:"mode"`
		}
		if err := decodeDeployment(w, r, &in); err != nil {
			middleware.WriteError(w, err)
			return
		}
		if in.Mode == "" {
			in.Mode = "source"
		}
		src, err := m.git(in.URL, in.Ref, in.Token, in.Mode)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 202, src)
	})
	r.Get("/sources/{sourceId}", func(w http.ResponseWriter, r *http.Request) {
		src, err := m.getSource(chi.URLParam(r, "sourceId"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, 200, src)
	})
	r.Get("/sources/{sourceId}/analysis", func(w http.ResponseWriter, r *http.Request) {
		src, err := m.getSource(chi.URLParam(r, "sourceId"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if src.Report == nil {
			shared.SendError(w, 409, "来源尚未识别完成")
			return
		}
		shared.SendJSON(w, 200, src.Report)
	})
	r.Delete("/sources/{sourceId}", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "sourceId")
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, t := range m.tasks {
			if t.SourceID == id && (activeDeployment(t.State) || t.State == "awaiting-config") {
				shared.SendError(w, 409, "来源正在被部署任务使用")
				return
			}
		}
		if cancel := m.cancel[id]; cancel != nil {
			cancel()
		}
		if !safeDeploymentID(id) {
			shared.SendError(w, 400, "来源标识无效")
			return
		}
		delete(m.sources, id)
		_ = os.RemoveAll(filepath.Join(m.sourceRoot, id))
		shared.SendJSON(w, 200, map[string]bool{"ok": true})
	})
	r.Post("/deployments", func(w http.ResponseWriter, r *http.Request) {
		var in deploymentInput
		if err := decodeDeployment(w, r, &in); err != nil {
			middleware.WriteError(w, err)
			return
		}
		task, err := m.submit(r.Context(), in)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 202, task)
	})
	r.Get("/deployments", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		rows := []deploymentTask{}
		for _, t := range m.tasks {
			b, _ := json.Marshal(t)
			var copy deploymentTask
			_ = json.Unmarshal(b, &copy)
			rows = append(rows, copy)
		}
		m.mu.Unlock()
		rows, err := m.reportTasks(r.Context(), rows)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, 200, rows)
	})
	r.Get("/deployments/{taskId}", func(w http.ResponseWriter, r *http.Request) {
		task, err := m.getTask(chi.URLParam(r, "taskId"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		rows, err := m.reportTasks(r.Context(), []deploymentTask{task})
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, 200, rows[0])
	})
	r.Get("/deployments/{taskId}/logs", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "taskId")
		if _, err := m.getTask(id); err != nil {
			middleware.WriteError(w, err)
			return
		}
		offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		if offset < 0 {
			shared.SendError(w, 400, "日志偏移无效")
			return
		}
		f, err := os.Open(filepath.Join(m.logRoot, id+".log"))
		lines := []string{}
		next, total := offset, int64(0)
		if err == nil {
			defer f.Close()
			info, e := f.Stat()
			if e != nil {
				middleware.WriteError(w, e)
				return
			}
			total = info.Size()
			if offset > total {
				offset = total
			}
			next = offset
			if _, err = f.Seek(offset, 0); err != nil {
				middleware.WriteError(w, err)
				return
			}
			reader := bufio.NewReader(io.LimitReader(f, 64<<10))
			for {
				line, e := reader.ReadString('\n')
				if line != "" {
					lines = append(lines, line)
					next += int64(len(line))
				}
				if e != nil {
					break
				}
			}
		} else if !os.IsNotExist(err) {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 200, map[string]any{"lines": lines, "next": next, "total": total})
	})
	r.Post("/deployments/{taskId}/cancel", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "taskId")
		task, err := m.getTask(id)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		m.mu.Lock()
		cancel := m.cancel[id]
		m.mu.Unlock()
		if cancel != nil {
			cancel()
			if activeDeployment(task.State) {
				_ = m.mutate(id, func(t *deploymentTask) { t.Stage = "正在取消并清理资源" })
			}
		}
		if task.State == "awaiting-config" {
			_ = m.mutate(id, func(t *deploymentTask) { t.State = "cancelled"; t.Stage = "已取消" })
			_ = os.RemoveAll(filepath.Join(m.sourceRoot, id+"-output"))
		}
		shared.SendJSON(w, 202, map[string]bool{"ok": true})
	})
	r.Post("/deployments/{taskId}/resume", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "taskId")
		task, err := m.getTask(id)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if task.State != "awaiting-config" {
			shared.SendError(w, 409, "任务没有等待补充配置")
			return
		}
		var cfg buildConfig
		if err = decodeDeployment(w, r, &cfg); err != nil {
			middleware.WriteError(w, err)
			return
		}
		if cfg.CandidateID != task.Config.CandidateID || cfg.BuildVersion != task.Config.BuildVersion || cfg.RuntimeVersion != task.Config.RuntimeVersion || cfg.Target != task.Config.Target {
			shared.SendError(w, 400, "构建已完成，仅可补充入口、产物和启动命令")
			return
		}
		src, err := m.getSource(task.SourceID)
		if err == nil {
			_, _, _, err = m.validateConfig(r.Context(), src, cfg)
		}
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		m.mu.Lock()
		t := m.tasks[id]
		if t.State != "awaiting-config" {
			m.mu.Unlock()
			shared.SendError(w, 409, "任务已经继续执行")
			return
		}
		updated := task
		updated.Config = cfg
		updated.Input.Config = cfg
		updated.State = "queued"
		updated.Error = ""
		updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		err = writeDeploymentJSON(filepath.Join(m.root, id+".json"), &updated)
		if err != nil {
			m.mu.Unlock()
			middleware.WriteError(w, err)
			return
		}
		m.tasks[id] = &updated
		ctx, cancel := context.WithCancel(context.Background())
		m.cancel[id] = cancel
		m.mu.Unlock()
		go m.execute(ctx, id)
		copy, _ := m.getTask(id)
		shared.SendJSON(w, 202, copy)
	})
	r.Post("/deployments/rollback/{projectId}", func(w http.ResponseWriter, r *http.Request) {
		task, err := m.rollback(r.Context(), chi.URLParam(r, "projectId"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 202, task)
	})
}
func (m *deploymentManager) rollback(ctx context.Context, id string) (deploymentTask, error) {
	row, err := m.service.record(ctx, id)
	if err != nil {
		return deploymentTask{}, err
	}
	if row.PreviousRelease == nil {
		return deploymentTask{}, shared.InvalidRequest("没有上一成功版本可回滚")
	}
	if !m.service.inProgress.acquire(id) {
		return deploymentTask{}, shared.InvalidRequest("项目正在执行其他操作")
	}
	taskID := newDeploymentID()
	now := time.Now().UTC().Format(time.RFC3339)
	t := deploymentTask{Port: row.Port, ID: taskID, SourceID: row.PreviousRelease.SourceID, ProjectID: id, Name: row.Name, State: "queued", Stage: "等待回滚", CreatedAt: now, UpdatedAt: now, TestResult: "skipped", Input: deploymentInput{ProjectID: id}, Config: buildConfig{CandidateID: "rollback", Target: row.PreviousRelease.Target, Command: row.PreviousRelease.Command, RuntimeVersion: row.PreviousRelease.RuntimeVersion, BuildVersion: row.PreviousRelease.BuildVersion, SkipTests: true}}
	parent, cancelTask := context.WithCancel(context.Background())
	m.mu.Lock()
	m.cancel[taskID] = cancelTask
	m.tasks[taskID] = &t
	err = writeDeploymentJSON(filepath.Join(m.root, taskID+".json"), &t)
	m.mu.Unlock()
	if err != nil {
		m.service.inProgress.remove(id)
		return t, err
	}
	go func() {
		defer func() { m.mu.Lock(); delete(m.cancel, taskID); m.mu.Unlock() }()
		defer m.service.inProgress.remove(id)
		ctx, cancel := context.WithTimeout(parent, m.engine.limits.Timeout)
		defer cancel()
		select {
		case m.workers <- struct{}{}:
		case <-ctx.Done():
			m.fail(taskID, ctx.Err(), true)
			return
		}
		defer func() { <-m.workers }()
		if err := m.service.assertRecordContainer(ctx, row); err != nil {
			m.fail(taskID, err, ctx.Err() == context.Canceled)
			return
		}
		previousRunning := false
		if row.ContainerID != nil {
			info, e := m.service.deps.docker.Inspect(ctx, *row.ContainerID)
			if e != nil {
				m.fail(taskID, e, false)
				return
			}
			previousRunning, _ = object(info["State"])["Running"].(bool)
		}
		oldRelease := *row.PreviousRelease
		updated := releaseAsRecord(row, oldRelease)
		updated.PreviousRelease = row.CurrentRelease
		name := m.service.deps.docker.NewContainerName()
		container, err := m.service.deps.docker.Create(ctx, containerCreateInput{ImageRef: oldRelease.RuntimeImage, Kind: runtimeRecordKind(updated), Version: runtimeRecordVersion(updated), ProjectID: id, Port: row.Port, BindSource: oldRelease.Directory, AccessMode: row.AccessMode, Command: updated.DeployCommand, ContainerName: name})
		if err != nil {
			m.fail(taskID, err, ctx.Err() == context.Canceled)
			return
		}
		updated.ContainerID = stringPtr(container)
		updated.ContainerName = stringPtr(name)
		updated = syncReleaseRecord(updated)
		if err = m.mutate(taskID, func(t *deploymentTask) {
			t.State = "publishing"
			t.Stage = "切换上一成功版本"
			t.Previous = &row
			t.PreviousRunning = previousRunning
			t.Pending = &updated
		}); err != nil {
			m.engine.remove(container)
			m.fail(taskID, err, ctx.Err() == context.Canceled)
			return
		}
		m.service.queue.run(func() {
			err = m.service.deps.docker.Stop(ctx, stringOrEmpty(row.ContainerID))
			if err == nil {
				err = m.service.deps.docker.Start(ctx, container)
			}
			if err == nil {
				err = m.ready(ctx, updated)
			}
			if err == nil {
				err = m.service.deps.registry.Put(ctx, updated)
			}
			if err != nil {
				restoreCtx, c := context.WithTimeout(context.Background(), 60*time.Second)
				defer c()
				current, _ := m.getTask(taskID)
				if e := m.restoreInterrupted(restoreCtx, &current); e != nil {
					err = errors.New(err.Error() + "；恢复失败：" + e.Error())
				}
			}
		})
		if err != nil {
			m.fail(taskID, err, ctx.Err() == context.Canceled)
			return
		}
		retired := releaseAsRecord(row, oldRelease)
		_, _ = m.service.deps.docker.RemoveManaged(ctx, recordIdentity(retired, m.service.deps.selfContainerID))
		_ = m.mutate(taskID, func(t *deploymentTask) {
			t.State = "succeeded"
			t.Stage = "已回滚"
			t.Release = updated.CurrentRelease
			t.Previous = nil
			t.Pending = nil
		})
	}()
	return t, nil
}
