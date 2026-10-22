package panel

import (
	"bytes"
	"context"
	"elysian/server/internal/config"
	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

type Manager struct {
	Store      Store
	Host       Host
	Source     Source
	Ports      config.PanelNetwork
	Enabled    bool
	Executable string
}
type Info struct {
	Ports      config.PanelNetwork `json:"ports"`
	Commit     string              `json:"commit"`
	BuildTime  string              `json:"buildTime"`
	Repository string              `json:"repository"`
	Available  bool                `json:"available"`
	Reason     string              `json:"reason"`
	ActiveTask *Task               `json:"activeTask"`
	LastTask   *Task               `json:"lastTask"`
}
type submitInput struct {
	RequestID    string        `json:"requestId"`
	FrontendPort int           `json:"frontendPort"`
	BackendPort  int           `json:"backendPort"`
	TargetCommit string        `json:"targetCommit"`
	Channel      UpdateChannel `json:"channel"`
	ReleaseTag   string        `json:"releaseTag"`
}

// 新记录暂缓探测；只有明确退出且长期未推进的任务才允许转终态。
const (
	workerProbeAfter  = time.Minute
	workerStaleAfter  = 10 * time.Minute
	workerProbeBudget = 5 * time.Second
)

func probeWorker(ctx context.Context, host Host, id string) WorkerStatus {
	probeCtx, cancel := context.WithTimeout(ctx, workerProbeBudget)
	defer cancel()
	status := host.ProbeWorker(probeCtx, id)
	if probeCtx.Err() != nil || (status != WorkerAlive && status != WorkerDead) {
		return WorkerUnknown
	}
	return status
}

func (m Manager) Info() (Info, error) {
	i := Info{Ports: m.Ports, Commit: Commit, BuildTime: BuildTime, Repository: Repository, Available: m.Enabled && m.Host.Available()}
	if !i.Available {
		i.Reason = "仅支持 systemd 安装版，请先使用安装脚本完成维护能力引导"
	}
	rows, err := m.Store.records()
	if err != nil {
		return i, err
	}
	if len(rows) > 0 {
		task := rows[0].Task
		i.LastTask = &task
	}
	for _, row := range rows {
		if Active(row.State) {
			supervised := m.superviseActive(row)
			if i.LastTask != nil && i.LastTask.ID == supervised.ID {
				task := supervised.Task
				i.LastTask = &task
			}
			if Active(supervised.State) || supervised.State == "recovery-failed" {
				i.ActiveTask = &supervised.Task
				break
			}
			continue
		}
		if row.State == "recovery-failed" {
			task := row.Task
			i.ActiveTask = &task
			break
		}
	}
	return i, nil
}

// 转终态必须同时确认单元退出、worker 锁空闲和最新记录超时。锁顺序与 worker
// 及启动恢复一致：worker.lock 在前，store.lock 在后；未知状态保持维护保护。
func (m Manager) superviseActive(row taskRecord) taskRecord {
	if !Active(row.State) || !m.Enabled || !m.Host.Available() {
		return row
	}
	if time.Since(row.UpdatedAt) < workerProbeAfter {
		return row
	}
	row.WorkerStatus = probeWorker(context.Background(), m.Host, row.ID)
	row.WorkerDead = row.WorkerStatus == WorkerDead
	if row.WorkerStatus != WorkerDead || time.Since(row.UpdatedAt) < workerStaleAfter {
		return row
	}
	workerLock, err := m.Store.tryWorkerLock()
	if err != nil {
		row.WorkerStatus, row.WorkerDead = WorkerUnknown, false
		return row
	}
	defer workerLock.Close()
	defer syscall.Flock(int(workerLock.Fd()), syscall.LOCK_UN)
	err = m.Store.lock(func() error {
		fresh, err := m.Store.read(row.ID)
		if err != nil {
			return err
		}
		row = fresh
		if !Active(fresh.State) {
			return nil
		}
		if time.Since(fresh.UpdatedAt) < workerStaleAfter {
			row.WorkerStatus, row.WorkerDead = WorkerUnknown, false
			return nil
		}
		fresh.WorkerStatus = probeWorker(context.Background(), m.Host, fresh.ID)
		fresh.WorkerDead = fresh.WorkerStatus == WorkerDead
		row = fresh
		if fresh.WorkerStatus != WorkerDead {
			return nil
		}
		fresh.WorkerDead = true
		fresh.Phase = "finished"
		fresh.UpdatedAt = time.Now().UTC()
		if !fresh.Activated && !fresh.FirewallCaptured {
			fresh.State = "failed"
			fresh.Error = "维护进程意外退出；未进入切换阶段，配置与数据未被改动。可在服务器执行 journalctl -u elysian-maintenance-" + fresh.ID + " 查看现场"
		} else {
			fresh.State = "recovery-failed"
			fresh.Error = "维护进程意外退出，原版本与配置尚未恢复" + recoveryHint(fresh.ID)
		}
		if err := m.Store.save(fresh); err != nil {
			return err
		}
		row = fresh
		m.Store.appendLog(fresh.ID, fresh.UpdatedAt.Format(time.RFC3339)+" "+fresh.Error+"\n")
		if fresh.Worker != "" {
			_ = os.Remove(fresh.Worker)
		}
		return nil
	})
	if err != nil {
		row.WorkerStatus, row.WorkerDead = WorkerUnknown, false
	}
	return row
}
func (m Manager) Check(ctx context.Context, channel UpdateChannel) (Update, error) {
	channel = normalizeChannel(channel)
	if !validChannel(channel) {
		return Update{}, shared.InvalidRequest("更新策略无效")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	u, err := m.Source.Check(ctx, channel)
	if err != nil {
		return u, err
	}
	err = config.AtomicJSON(m.Store.updateCheckPath(channel), u)
	return u, err
}

func (m Manager) Submit(ctx context.Context, kind string, input submitInput, origin string) (Task, error) {
	var result Task
	if !m.Enabled || !m.Host.Available() {
		return result, &shared.InvalidRequestError{Status: 503, Message: "仅支持 systemd 安装版，请先使用安装脚本完成维护能力引导"}
	}
	if !requestPattern.MatchString(input.RequestID) {
		return result, shared.InvalidRequest("提交编号无效")
	}
	if kind == "update" {
		input.Channel = normalizeChannel(input.Channel)
		if !validChannel(input.Channel) {
			return result, shared.InvalidRequest("更新策略无效")
		}
		if input.Channel == ChannelCommit && input.ReleaseTag != "" {
			return result, shared.InvalidRequest("最新提交策略不能指定发版标签")
		}
	}
	next := m.Ports
	if kind == "ports" {
		next = config.PanelNetwork{FrontendPort: input.FrontendPort, BackendPort: input.BackendPort}
	}
	if err := next.Validate(); err != nil {
		return result, shared.InvalidRequest(err.Error())
	}
	err := m.Store.mutationGate(false, func() error {
		return m.Store.lock(func() error {
			rows, err := m.Store.records()
			if err != nil {
				return err
			}
			for _, row := range rows {
				if row.RequestID == input.RequestID {
					if row.Kind != kind || (kind == "ports" && row.NewPorts != next) || row.TargetCommit != input.TargetCommit || (kind == "update" && (normalizeChannel(row.UpdateChannel) != input.Channel || row.ReleaseTag != input.ReleaseTag)) {
						return shared.InvalidRequest("提交编号已用于不同操作")
					}
					result = row.Task
					return nil
				}
			}
			for _, row := range rows {
				if Active(row.State) || row.State == "recovery-failed" {
					return &shared.InvalidRequestError{Status: 409, Message: "面板维护任务尚未完成，请等待或处理恢复错误"}
				}
			}
			if kind == "update" {
				var u Update
				b, err := os.ReadFile(m.Store.updateCheckPath(input.Channel))
				if err != nil || json.Unmarshal(b, &u) != nil || u.Repository != Repository || normalizeChannel(u.Channel) != input.Channel || !u.Available || !commitPattern.MatchString(input.TargetCommit) || u.TargetCommit != input.TargetCommit || u.ReleaseTag != input.ReleaseTag || (input.Channel == ChannelRelease && u.ReleaseTag == "") {
					return shared.InvalidRequest("请先检查更新，再提交已检查的目标版本")
				}
			}
			id, err := newID()
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			r := taskRecord{Task: Task{ID: id, Kind: kind, State: "queued", Phase: "checking", CreatedAt: now, UpdatedAt: now, OldPorts: m.Ports, NewPorts: next, TargetCommit: input.TargetCommit}, RequestID: input.RequestID, Origin: origin}
			if kind == "update" {
				r.UpdateChannel = input.Channel
				r.ReleaseTag = input.ReleaseTag
			}
			r.Worker = filepath.Join(m.Store.tasksDir(), id+".worker")
			executable := m.Executable
			if executable == "" {
				executable, err = os.Executable()
				if err != nil {
					return err
				}
			}
			if err = copyRegular(executable, r.Worker, 0700); err != nil {
				return err
			}
			if err = m.Store.save(r); err != nil {
				_ = os.Remove(r.Worker)
				return err
			}
			dispatchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer cancel()
			if err = m.Host.Dispatch(dispatchCtx, r.Worker, id); err != nil {
				r.WorkerStatus = probeWorker(context.WithoutCancel(ctx), m.Host, id)
				if r.WorkerStatus == WorkerAlive {
					result = r.Task
					return nil
				}
				if r.WorkerStatus == WorkerUnknown {
					m.Store.appendLog(id, "维护服务派发结果暂未确认，保留任务等待核实："+err.Error()+"\n")
					if err = m.Store.save(r); err != nil {
						return err
					}
					result = r.Task
					return nil
				}
				r.State = "failed"
				r.Phase = "finished"
				r.UpdatedAt = time.Now().UTC()
				r.WorkerDead = true
				r.Error = "维护服务启动失败：" + err.Error()
				if err = m.Store.save(r); err != nil {
					return err
				}
				_ = os.Remove(r.Worker)
				result = r.Task
				return nil
			}
			result = r.Task
			return nil
		})
	})
	return result, err
}

func (m Manager) Router() chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.EndpointErrorHandler)
	r.Use(middleware.SameOriginGuard())
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		info, err := m.Info()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 200, info)
	})
	r.Get("/update", func(w http.ResponseWriter, r *http.Request) {
		channel := normalizeChannel(UpdateChannel(r.URL.Query().Get("channel")))
		if !validChannel(channel) {
			shared.SendError(w, 400, "更新策略无效")
			return
		}
		if !m.Enabled || !m.Host.Available() {
			shared.SendError(w, 503, "仅支持 systemd 安装版")
			return
		}
		u, err := m.Check(r.Context(), channel)
		if err != nil {
			shared.SendError(w, 502, err.Error())
			return
		}
		shared.SendJSON(w, 200, u)
	})
	// 更新日志：列所选来源最近的提交。只读上游，不写状态，因此不经维护事务与互斥。
	r.Get("/commits", func(w http.ResponseWriter, r *http.Request) {
		channel := normalizeChannel(UpdateChannel(r.URL.Query().Get("channel")))
		if !validChannel(channel) {
			shared.SendError(w, 400, "更新策略无效")
			return
		}
		if !m.Enabled || !m.Host.Available() {
			shared.SendError(w, 503, "仅支持 systemd 安装版")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		commits, err := m.Source.History(ctx, channel, 50)
		if err != nil {
			shared.SendError(w, 502, err.Error())
			return
		}
		shared.SendJSON(w, 200, commits)
	})
	for _, route := range []struct{ method, path, kind string }{{"PUT", "/ports", "ports"}, {"POST", "/restart", "restart"}, {"POST", "/update", "update"}} {
		kind := route.kind
		r.MethodFunc(route.method, route.path, func(w http.ResponseWriter, r *http.Request) {
			body, err := middleware.ReadJSONBody(w, r, 8192)
			if err != nil {
				middleware.WriteError(w, err)
				return
			}
			b, err := json.Marshal(body)
			if err != nil {
				middleware.WriteError(w, err)
				return
			}
			var input submitInput
			d := json.NewDecoder(bytes.NewReader(b))
			d.DisallowUnknownFields()
			if err = d.Decode(&input); err != nil {
				shared.SendError(w, 400, "维护请求字段无效，端口必须为整数")
				return
			}
			task, err := m.Submit(r.Context(), kind, input, r.Header.Get("Origin"))
			if err != nil {
				middleware.WriteError(w, err)
				return
			}
			shared.SendJSON(w, 202, task)
		})
	}
	r.Get("/tasks/by-request/{requestId}", func(w http.ResponseWriter, r *http.Request) {
		requestID := chi.URLParam(r, "requestId")
		if !requestPattern.MatchString(requestID) {
			shared.SendError(w, 400, "提交编号无效")
			return
		}
		rows, err := m.Store.records()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		for _, row := range rows {
			if row.RequestID == requestID {
				row = m.superviseActive(row)
				shared.SendJSON(w, 200, row.Task)
				return
			}
		}
		shared.SendError(w, 404, "维护请求尚未找到对应任务")
	})
	r.Get("/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		row, err := m.Store.read(chi.URLParam(r, "id"))
		if err != nil {
			shared.SendError(w, 404, "维护任务不存在或记录损坏")
			return
		}
		// 轮询路径同时承担存活监管：维护单元死掉的任务不会永远停在 queued/running。
		row = m.superviseActive(row)
		offset := int64(0)
		if raw := r.URL.Query().Get("offset"); raw != "" {
			offset, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || offset < 0 || offset > 2*1024*1024 {
				shared.SendError(w, 400, "日志游标无效")
				return
			}
		}
		text := ""
		hasMore := false
		f, err := os.Open(m.Store.logPath(row.ID))
		if err == nil {
			_, err = f.Seek(offset, 0)
			if err == nil {
				b, e := io.ReadAll(io.LimitReader(f, 32768))
				err = e
				if len(b) > 0 {
					start := len(b) - 1
					for start >= 0 && !utf8.RuneStart(b[start]) {
						start--
					}
					if start >= 0 && !utf8.FullRune(b[start:]) {
						b = b[:start]
					}
				}
				text = string(b)
				offset += int64(len(b))
				if st, e := f.Stat(); e == nil {
					hasMore = offset < st.Size()
				}
			}
			f.Close()
		} else if os.IsNotExist(err) {
			err = nil
		}
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, 200, struct {
			Task       Task   `json:"task"`
			Logs       string `json:"logs"`
			NextOffset int64  `json:"nextOffset"`
			HasMore    bool   `json:"hasMore"`
		}{row.Task, text, offset, hasMore})
	})
	return r
}

// WriteGuard 在维护期间阻止配置、规则或新部署与备份/切换并发。登录退出仍可用。
func (m Manager) WriteGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.Enabled || r.Method == "GET" || r.Method == "HEAD" || !strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/api/panel/") || r.URL.Path == "/api/auth/login" || r.URL.Path == "/api/auth/logout" {
			next.ServeHTTP(w, r)
			return
		}
		err := m.Store.mutationGate(true, func() error {
			info, err := m.Info()
			if err != nil {
				return err
			}
			if info.ActiveTask != nil {
				shared.SendError(w, 409, "面板正在维护，暂不能修改配置或执行部署")
				return nil
			}
			next.ServeHTTP(w, r)
			return nil
		})
		if err != nil {
			middleware.WriteError(w, err)
		}
	})
}

// Health 仅在端口迁移时临时允许提交请求的旧 Origin 探测；不发送凭据或任务日志。
func (m Manager) Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ready := false
	if id := r.URL.Query().Get("maintenanceTask"); idPattern.MatchString(id) {
		if row, err := m.Store.read(id); err == nil {
			if row.Origin != "" && r.Header.Get("Origin") == row.Origin && time.Since(row.UpdatedAt) <= 2*time.Minute && row.NewPorts == m.Ports {
				w.Header().Set("Access-Control-Allow-Origin", row.Origin)
				w.Header().Set("Vary", "Origin")
			}
			ready = row.Committed && row.State == "succeeded" && row.NewPorts == m.Ports
		}
	}
	shared.SendJSON(w, 200, struct {
		OK     bool                `json:"ok"`
		Ready  bool                `json:"ready"`
		Commit string              `json:"commit"`
		Ports  config.PanelNetwork `json:"ports"`
	}{true, ready, Commit, m.Ports})
}

func RunCLI(ctx context.Context, command string, args []string, root, socket string) (err error) {
	// 维护命令以 systemd 瞬态单元或 ExecStartPre 运行，没有 HTTP 层的 panic 兜底：
	// 这里兜住异常并转成错误返回，让 systemd 记录失败而不是静默冻结任务。
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("维护命令异常退出：%v", p)
		}
	}()
	s := Store{Root: root}
	host := SystemHost{Store: s, DockerSocket: socket}
	worker := Worker{Store: s, Host: host, Source: DefaultSource()}
	if command == "maintenance-recover" && len(args) == 0 {
		return worker.Recover(ctx)
	}
	if command == "maintenance-worker" && len(args) == 1 {
		return worker.Run(ctx, args[0])
	}
	return fmt.Errorf("维护命令参数无效")
}
