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
	RequestID    string `json:"requestId"`
	FrontendPort int    `json:"frontendPort"`
	BackendPort  int    `json:"backendPort"`
	TargetCommit string `json:"targetCommit"`
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
		if Active(row.State) || row.State == "recovery-failed" {
			task := row.Task
			i.ActiveTask = &task
			break
		}
	}
	return i, nil
}
func (m Manager) Check(ctx context.Context) (Update, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	u, err := m.Source.Check(ctx)
	if err != nil {
		return u, err
	}
	err = config.AtomicJSON(filepath.Join(m.Store.Root, "state", "panel-update-check.json"), u)
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
					if row.Kind != kind || (kind == "ports" && row.NewPorts != next) || row.TargetCommit != input.TargetCommit {
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
				b, err := os.ReadFile(filepath.Join(m.Store.Root, "state", "panel-update-check.json"))
				if err != nil || json.Unmarshal(b, &u) != nil || !u.Available || !commitPattern.MatchString(input.TargetCommit) || u.TargetCommit != input.TargetCommit {
					return shared.InvalidRequest("请先检查更新，再提交已检查的目标版本")
				}
			}
			if err = m.Host.Preflight(ctx, m.Ports, next); err != nil {
				return shared.InvalidRequest(err.Error())
			}
			id, err := newID()
			if err != nil {
				return err
			}
			now := time.Now().UTC()
			r := taskRecord{Task: Task{ID: id, Kind: kind, State: "queued", Phase: "checking", CreatedAt: now, UpdatedAt: now, OldPorts: m.Ports, NewPorts: next, TargetCommit: input.TargetCommit}, RequestID: input.RequestID, Origin: origin}
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
				if m.Host.WorkerActive(dispatchCtx, id) {
					result = r.Task
					return nil
				}
				r.State = "failed"
				r.Error = "维护服务启动失败：" + err.Error()
				_ = m.Store.save(r)
				_ = os.Remove(r.Worker)
				return err
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
		if !m.Enabled || !m.Host.Available() {
			shared.SendError(w, 503, "仅支持 systemd 安装版")
			return
		}
		u, err := m.Check(r.Context())
		if err != nil {
			shared.SendError(w, 502, err.Error())
			return
		}
		shared.SendJSON(w, 200, u)
	})
	// 更新日志：列默认分支最近的提交。只读上游，不写状态，因此不经维护事务与互斥。
	r.Get("/commits", func(w http.ResponseWriter, r *http.Request) {
		if !m.Enabled || !m.Host.Available() {
			shared.SendError(w, 503, "仅支持 systemd 安装版")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		commits, err := m.Source.History(ctx, 50)
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
	r.Get("/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		row, err := m.Store.read(chi.URLParam(r, "id"))
		if err != nil {
			shared.SendError(w, 404, "维护任务不存在或记录损坏")
			return
		}
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

func RunCLI(ctx context.Context, command string, args []string, root, socket string) error {
	s := Store{Root: root}
	host := SystemHost{Store: s, DockerSocket: socket}
	worker := Worker{Store: s, Host: host, Source: GitHubSource{}}
	if command == "maintenance-recover" && len(args) == 0 {
		return worker.Recover(ctx)
	}
	if command == "maintenance-worker" && len(args) == 1 {
		return worker.Run(ctx, args[0])
	}
	return fmt.Errorf("维护命令参数无效")
}
