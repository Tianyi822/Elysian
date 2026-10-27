package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/termui"
	"elysian/server/internal/cli/tui"
	"github.com/mattn/go-isatty"
)

type maintenanceAPI interface {
	PanelInfo(context.Context) (client.PanelInfo, error)
	CheckPanelUpdate(context.Context, string, string) (client.PanelUpdate, error)
	PanelCommits(context.Context, string, string) ([]client.PanelCommit, error)
	SubmitPanelUpdate(context.Context, client.PanelUpdateInput) (client.PanelTask, error)
	PanelTaskByRequest(context.Context, string) (*client.PanelTask, error)
	PanelTaskReport(context.Context, string, int64) (client.PanelTaskReport, error)
	RetryPanelCLI(context.Context, string) (client.PanelTask, error)
	PanelHealth(context.Context) (string, error)
}

type upgradeState struct {
	Version   int                     `json:"version"`
	BaseURL   string                  `json:"baseURL"`
	PanelHome string                  `json:"panelHome"`
	Input     client.PanelUpdateInput `json:"input"`
	TaskID    string                  `json:"taskId,omitempty"`
}

type upgradeStore struct{ path string }

func (s upgradeStore) read(baseURL, home string) (*upgradeState, error) {
	raw, err := readLocalFile(s.path)
	if err != nil || raw == nil {
		return nil, err
	}
	var state upgradeState
	if json.Unmarshal(raw, &state) != nil || state.Version != 1 || state.BaseURL == "" || (state.TaskID == "" && state.Input.RequestID == "") {
		return nil, errors.New("更新恢复记录损坏，已保留原文件：" + s.path)
	}
	if state.BaseURL != baseURL || state.PanelHome != home {
		return nil, errors.New("更新恢复记录属于其他面板，请先核对：" + s.path)
	}
	return &state, nil
}
func (s upgradeStore) save(state upgradeState) error { return writeLocalFile(s.path, state) }
func (s upgradeStore) clear() error {
	err := os.Remove(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// 同一执行用户只允许一份更新控制器写恢复记录；服务端维护锁仍是跨入口权威。
func lockUpgrade(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "upgrade.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("另一 ely upgrade 正在运行，请在原终端查看进度")
	}
	return f, nil
}

func runUpgrade(opts upgradeOptions, stdin *os.File, stdout, stderr io.Writer, d deps) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	interactive := stdin != nil && isatty.IsTerminal(stdin.Fd())
	store, err := newCLIStore("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	lock, err := lockUpgrade(store.dir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer lock.Close()
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	home, err := resolvePanelHome(d.getenv, d.fileExists, d.userHome)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	var baseURL, cookie string
	if interactive {
		baseURL, cookie, err = tui.Authenticate(stdin, stdout, d.agentDeps())
	} else {
		baseURL, err = discoverBackend(ctx, d)
		if err == nil {
			var saved StoredSession
			saved, err = store.ReadSession()
			if err == nil {
				cookie = saved.Cookie
			}
		}
	}
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, tui.ErrExitCLI) {
			return 130
		}
		if errors.Is(err, context.Canceled) {
			return 0
		}
		fmt.Fprintln(stderr, termui.Safe(err.Error()))
		return 1
	}
	api := client.New(baseURL)
	api.SetSessionCookie(cookie)
	if cookie == "" {
		fmt.Fprintln(stderr, "尚未登录，请在交互终端运行 ely upgrade 完成登录后重试。")
		return 1
	}
	info, err := api.PanelInfo(ctx)
	if err != nil {
		fmt.Fprintln(stderr, termui.Safe(err.Error()), "；可运行 ely upgrade 重新登录")
		return 1
	}
	if !info.Available {
		if info.Reason == "" {
			info.Reason = "仅支持 systemd 安装版，请先完成维护能力引导"
		}
		fmt.Fprintln(stderr, termui.Safe(info.Reason))
		return 1
	}
	persistence := upgradeStore{path: filepath.Join(store.dir, "upgrade.json")}
	saved, err := persistence.read(baseURL, home)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	state := upgradeState{Version: 1, BaseURL: baseURL, PanelHome: home}
	if saved != nil {
		state = *saved
		fmt.Fprintln(stdout, "恢复上次更新请求，沿用已保存的来源、目标和请求编号。")
		if state.TaskID == "" {
			found, findErr := api.PanelTaskByRequest(ctx, state.Input.RequestID)
			if findErr != nil {
				fmt.Fprintln(stderr, termui.Safe(findErr.Error()))
				return 1
			}
			if found != nil {
				state.TaskID = found.ID
				if err = persistence.save(state); err != nil {
					fmt.Fprintln(stderr, err)
					return 1
				}
			} else {
				if !interactive && (opts.Source != state.Input.Source || opts.Channel != state.Input.Channel) {
					fmt.Fprintln(stderr, "存在未确认的更新，请使用原来源和策略重试。")
					return 1
				}
				if interactive && !opts.Yes {
					choice, code := chooseUpgrade(stdin, stdout, "恢复更新请求", "尚未找到上次请求。重试将沿用原目标和请求编号。", []string{"取消，保留请求", "重试原请求"}, nil)
					if code != 0 {
						return code
					}
					if choice != 1 {
						return 0
					}
				}
			}
		}
	} else if info.ActiveTask != nil {
		state.TaskID = info.ActiveTask.ID
		fmt.Fprintln(stdout, "已有面板维护任务，继续查看：", state.TaskID)
		if err = persistence.save(state); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	} else {
		if opts.Source == "" {
			choice, code := chooseUpgrade(stdin, stdout, "选择更新来源", "检查、说明与源码下载均固定使用所选来源。", []string{"GitHub · Tianyi822/Elysian", "Gitee · Chentyit/Elysian"}, nil)
			if code != 0 {
				return code
			}
			if choice < 0 {
				return 0
			}
			opts.Source = []string{"github", "gitee"}[choice]
		}
		if opts.Channel == "" {
			choice, code := chooseUpgrade(stdin, stdout, "选择版本策略", "最新发版只包含正式 Release，不包含预发布版本。", []string{"最新提交 · 默认分支的最新改动", "最新发版 · 最新正式 Release"}, nil)
			if code != 0 {
				return code
			}
			if choice < 0 {
				return 0
			}
			opts.Channel = []string{"commit", "release"}[choice]
		}
		fmt.Fprintln(stdout, "◉ 正在检查更新 ·", sourceLabel(opts.Source), "·", channelLabel(opts.Channel))
		update, checkErr := api.CheckPanelUpdate(ctx, opts.Source, opts.Channel)
		if checkErr != nil {
			fmt.Fprintln(stderr, termui.Safe(checkErr.Error()))
			return 1
		}
		if update.Source != opts.Source || update.Channel != opts.Channel {
			fmt.Fprintln(stderr, "更新检查响应的来源或策略不匹配，请重新检查。")
			return 1
		}
		if !update.Available {
			fmt.Fprintln(stdout, "✓ 无需更新：", termui.Safe(update.Message))
			return 0
		}
		if !regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`).MatchString(update.TargetCommit) || opts.Channel == "release" && update.ReleaseTag == "" {
			fmt.Fprintln(stderr, "检查结果缺少完整目标版本，未提交更新。")
			return 1
		}
		summary := fmt.Sprintf("来源：%s · %s\n当前提交：%s\n目标提交：%s", sourceLabel(opts.Source), channelLabel(opts.Channel), termui.Safe(update.CurrentCommit), update.TargetCommit)
		if update.ReleaseTag != "" {
			summary += "\n正式发版：" + termui.Safe(update.ReleaseTag)
		}
		summary += "\n\n" + termui.Safe(update.Message) + "\n\n更新会构建新版本并重启面板，失败按维护机制恢复原版本。"
		if !opts.Yes {
			choice, code := chooseUpgrade(stdin, stdout, "确认更新", summary, []string{"取消更新", "更新并重启"}, func(ctx context.Context) (string, error) {
				commits, err := api.PanelCommits(ctx, opts.Source, opts.Channel)
				if err != nil {
					return "", err
				}
				var text string
				for _, c := range commits {
					text += c.SHA + "  " + c.Time + "\n" + termui.Safe(c.Message) + "\n\n"
				}
				if text == "" {
					text = "暂无更新说明"
				}
				return text, nil
			})
			if code != 0 {
				return code
			}
			if choice != 1 {
				return 0
			}
		} else {
			fmt.Fprintln(stdout, summary)
		}
		idBytes := make([]byte, 16)
		if _, err = rand.Read(idBytes); err != nil {
			fmt.Fprintln(stderr, "生成请求编号失败：", err)
			return 1
		}
		state.Input = client.PanelUpdateInput{RequestID: hex.EncodeToString(idBytes), Source: opts.Source, Channel: opts.Channel, TargetCommit: update.TargetCommit, ReleaseTag: update.ReleaseTag}
		if err = persistence.save(state); err != nil {
			fmt.Fprintln(stderr, "无法保存恢复记录，未提交更新：", err)
			return 1
		}
	}
	runtime := upgradeRuntime{api: api, store: persistence, pause: pauseUpgrade, now: time.Now, retryCLI: !interactive && saved != nil && opts.Yes}
	code, err := monitorUpgrade(ctx, stdin, stdout, interactive, runtime, state)
	if err != nil {
		fmt.Fprintln(stderr, termui.Safe(err.Error()))
	}
	return code
}

type upgradeRuntime struct {
	retryCLI bool
	api      maintenanceAPI
	store    upgradeStore
	pause    func(context.Context, time.Duration) error
	now      func() time.Time
}
type upgradeProgress struct {
	Task         client.PanelTask
	Logs, Notice string
	Retry        bool
}

func pauseUpgrade(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func uncertainUpgrade(err error) bool {
	var e *client.Error
	return !errors.As(err, &e) || e.Status == 0 || e.Status >= 500
}
func transportUpgrade(err error) bool {
	var e *client.Error
	return errors.As(err, &e) && (e.Kind == client.KindUnreachable || e.Kind == client.KindNotRunning)
}

func (r upgradeRuntime) submit(ctx context.Context, state *upgradeState) error {
	task, err := r.api.SubmitPanelUpdate(ctx, state.Input)
	if err != nil {
		return err
	}
	if task.ID == "" {
		return errors.New("更新已响应，但未返回任务编号；保留请求等待核实")
	}
	state.TaskID = task.ID
	return r.store.save(*state)
}

// follow 对账、分页读日志、重连及终态核对共用一个控制器，TTY 与脚本行为一致。
func (r upgradeRuntime) follow(ctx context.Context, state upgradeState, report func(upgradeProgress), retry <-chan struct{}) (int, error) {
	if state.TaskID == "" {
		if err := r.submit(ctx, &state); err != nil {
			if !uncertainUpgrade(err) {
				if clearErr := r.store.clear(); clearErr != nil {
					return 1, clearErr
				}
				return 1, err
			}
			report(upgradeProgress{Notice: "提交结果未确认，正在按原请求编号核实；r 重试原请求。", Retry: true})
		}
	}
	pendingSince := r.now()
	retriedCLI := false
	offset := int64(0)
	for {
		if ctx.Err() != nil {
			return 130, ctx.Err()
		}
		if state.TaskID == "" {
			task, err := r.api.PanelTaskByRequest(ctx, state.Input.RequestID)
			if err != nil && !transportUpgrade(err) {
				return 1, err
			}
			if task != nil {
				state.TaskID = task.ID
				if err = r.store.save(state); err != nil {
					return 1, err
				}
				continue
			}
			if r.now().Sub(pendingSince) >= 3*time.Minute {
				return 1, errors.New("提交结果仍未确认，恢复记录已保留；再次运行 ely upgrade 核实或重试原请求")
			}
			select {
			case <-retry:
				if err := r.submit(ctx, &state); err != nil {
					report(upgradeProgress{Notice: err.Error(), Retry: true})
				}
			default:
			}
			if err := r.pause(ctx, 2*time.Second); err != nil {
				return 130, err
			}
			continue
		}
		reportData, err := r.api.PanelTaskReport(ctx, state.TaskID, offset)
		if err != nil {
			if ctx.Err() != nil {
				return 130, ctx.Err()
			}
			if !transportUpgrade(err) {
				return 1, err
			}
			report(upgradeProgress{Notice: "连接暂时中断，正在等待面板恢复；更新任务仍由服务器执行。"})
			if err := r.pause(ctx, 5*time.Second); err != nil {
				return 130, err
			}
			continue
		}
		task := reportData.Task
		if task.ID != state.TaskID || reportData.NextOffset < offset || reportData.HasMore && reportData.NextOffset == offset {
			return 1, errors.New("维护任务或日志游标响应无效，恢复记录已保留")
		}
		offset = reportData.NextOffset
		report(upgradeProgress{Task: task, Logs: reportData.Logs})
		if reportData.HasMore {
			continue
		}
		if task.Active() {
			if err := r.pause(ctx, 2*time.Second); err != nil {
				return 130, err
			}
			continue
		}
		if task.State != "succeeded" {
			if task.State != "failed" && task.State != "rolled-back" && task.State != "recovery-failed" {
				return 1, errors.New("维护任务状态无效，恢复记录已保留")
			}
			if task.State != "recovery-failed" {
				if err := r.store.clear(); err != nil {
					return 1, err
				}
			}
			return 1, fmt.Errorf("%s：%s", taskStateLabel(task.State), task.Error)
		}
		if task.CLIRegistration != nil && task.CLIRegistration.Status == "pending" {
			if err := r.pause(ctx, time.Second); err != nil {
				return 130, err
			}
			continue
		}
		if task.CLIRegistration != nil && task.CLIRegistration.Status == "failed" {
			err := fmt.Errorf("面板已更新，CLI 注册失败：%s；再次运行 ely upgrade 可继续处理", task.CLIRegistration.Error)
			if retry == nil && r.retryCLI && !retriedCLI {
				retriedCLI = true
				if _, retryErr := r.api.RetryPanelCLI(ctx, task.ID); retryErr != nil {
					return 1, retryErr
				}
				continue
			}
			if retry == nil {
				return 1, err
			}
			report(upgradeProgress{Task: task, Notice: err.Error(), Retry: true})
			select {
			case <-ctx.Done():
				return 130, ctx.Err()
			case <-retry:
			}
			if _, err := r.api.RetryPanelCLI(ctx, task.ID); err != nil {
				report(upgradeProgress{Task: task, Notice: err.Error(), Retry: true})
				if err := r.pause(ctx, time.Second); err != nil {
					return 130, err
				}
			}
			continue
		}
		if task.Kind == "update" {
			commit, err := r.api.PanelHealth(ctx)
			if err != nil && transportUpgrade(err) {
				report(upgradeProgress{Task: task, Notice: "任务已完成，等待面板恢复后核对运行版本。"})
				if err := r.pause(ctx, 2*time.Second); err != nil {
					return 130, err
				}
				continue
			}
			if err != nil {
				return 1, err
			}
			if commit == "" || commit != task.TargetCommit {
				return 1, fmt.Errorf("面板已恢复，但运行版本 %s 与目标 %s 不一致；恢复指针已保留，请核对任务日志", commit, task.TargetCommit)
			}
		}
		if err := r.store.clear(); err != nil {
			return 1, err
		}
		notice := "✓ 面板维护已完成。"
		if task.Kind == "update" {
			notice = "✓ 面板维护已完成，运行版本已核对。"
		}
		report(upgradeProgress{Task: task, Notice: notice})
		return 0, nil
	}
}

func sourceLabel(source string) string {
	if source == "gitee" {
		return "Gitee"
	}
	if source == "github" {
		return "GitHub"
	}
	return source
}
func channelLabel(channel string) string {
	if channel == "release" {
		return "最新发版"
	}
	if channel == "commit" {
		return "最新提交"
	}
	return channel
}
func taskStateLabel(state string) string {
	labels := map[string]string{"queued": "等待执行", "running": "正在执行", "succeeded": "已完成", "failed": "执行失败", "rolled-back": "已恢复原配置或版本", "recovery-failed": "恢复失败，需要在服务器处理"}
	if label := labels[state]; label != "" {
		return label
	}
	return state
}
func taskPhaseLabel(phase string) string {
	labels := map[string]string{"checking": "检查部署环境", "downloading": "下载源码", "building": "构建新版本", "firewall": "调整防火墙", "stopping": "停止面板", "activating": "切换配置与版本", "verifying": "检查服务健康", "finished": "已结束"}
	if label := labels[phase]; label != "" {
		return label
	}
	return phase
}
