package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"elysian/server/internal/cli/termui"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

type upgradeDetailsMsg struct {
	text string
	err  error
}
type upgradeChoice struct {
	title, body          string
	items                []string
	cursor, chosen, code int
	width, height        int
	viewport             viewport.Model
	details              func(context.Context) (string, error)
	detailOpen, loading  bool
	detailBody           string
	ctx                  context.Context
}

func chooseUpgrade(stdin *os.File, stdout io.Writer, title, body string, items []string, details func(context.Context) (string, error)) (int, int) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := upgradeChoice{title: title, body: body, items: items, chosen: -1, width: 78, height: 24, viewport: viewport.New(78, 12), details: details, ctx: ctx}
	m.resize()
	final, err := tea.NewProgram(m, tea.WithInput(stdin), tea.WithOutput(stdout)).Run()
	if err != nil {
		if !errors.Is(err, tea.ErrInterrupted) && !errors.Is(err, tea.ErrProgramKilled) {
			fmt.Fprintln(stdout, "终端交互失败：", err)
			return -1, 1
		}
		return -1, 130
	}
	result, ok := final.(upgradeChoice)
	if !ok {
		return -1, 1
	}
	return result.chosen, result.code
}
func (m upgradeChoice) Init() tea.Cmd { return nil }
func (m *upgradeChoice) resize() {
	m.viewport.Width = max(1, m.width)
	hints := m.hints()
	m.viewport.Height = max(1, m.height-lipgloss.Height(termui.Header(m.title, "", m.width))-len(m.items)-lipgloss.Height(hints)-3)
	body := m.body
	if m.detailOpen {
		body = m.detailBody
	}
	m.viewport.SetContent(ansi.Wrap(body, max(1, m.width), ""))
}
func (m upgradeChoice) hints() string {
	if m.detailOpen {
		return termui.Hints("↑↓ / PgUp/PgDn 滚动 · Esc 返回确认 · Ctrl+C 退出", m.width)
	}
	hint := "↑/↓ 选择 · Enter 确认 · Esc 取消 · PgUp/PgDn 滚动"
	if m.details != nil {
		hint += " · l 更新说明"
	}
	return termui.Hints(hint, m.width)
}
func (m upgradeChoice) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.resize()
	case upgradeDetailsMsg:
		if !m.detailOpen {
			return m, nil
		}
		m.loading = false
		if msg.err != nil {
			m.detailBody = termui.Safe(msg.err.Error())
		} else {
			m.detailBody = termui.Safe(msg.text)
		}
		m.resize()
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			m.code = 130
			return m, tea.Quit
		}
		if m.detailOpen {
			if msg.String() == "esc" {
				m.detailOpen = false
				m.resize()
				m.viewport.GotoTop()
				return m, nil
			}
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}
		switch msg.String() {
		case "up", "k":
			m.cursor = (m.cursor + len(m.items) - 1) % len(m.items)
		case "down", "j":
			m.cursor = (m.cursor + 1) % len(m.items)
		case "enter":
			m.chosen = m.cursor
			return m, tea.Quit
		case "esc":
			return m, tea.Quit
		case "l":
			if m.details != nil {
				m.detailOpen = true
				m.loading = true
				m.detailBody = "正在读取所选来源的更新说明…"
				m.resize()
				m.viewport.GotoTop()
				return m, func() tea.Msg { text, err := m.details(m.ctx); return upgradeDetailsMsg{text, err} }
			}
		case "pgup", "pgdown":
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}
	}
	return m, nil
}
func (m upgradeChoice) View() string {
	var b strings.Builder
	b.WriteString(termui.Header(m.title, "", m.width))
	b.WriteString(m.viewport.View() + "\n\n")
	if !m.detailOpen {
		for i, item := range m.items {
			if i == m.cursor {
				b.WriteString(termui.Accent.Render("❯ " + item))
			} else {
				b.WriteString("  " + item)
			}
			b.WriteString("\n")
		}
	}
	b.WriteString(m.hints() + "\n")
	return termui.Fit(b.String(), m.width)
}

type upgradeDone struct {
	code int
	err  error
}
type upgradeMonitor struct {
	progress      upgradeProgress
	width, height int
	logs          string
	viewport      viewport.Model
	spinner       spinner.Model
	start         time.Time
	follow        bool
	retry         chan<- struct{}
	code          int
	err           error
	completed     bool
}

func monitorUpgrade(ctx context.Context, stdin *os.File, stdout io.Writer, interactive bool, runtime upgradeRuntime, state upgradeState) (int, error) {
	if !interactive {
		lastNotice, lastPhase := "", ""
		return runtime.follow(ctx, state, func(p upgradeProgress) {
			if p.Task.Phase != "" && p.Task.Phase != lastPhase {
				fmt.Fprintln(stdout, "◉", taskPhaseLabel(p.Task.Phase), "·", p.Task.ID)
				lastPhase = p.Task.Phase
			}
			if p.Logs != "" {
				fmt.Fprint(stdout, termui.Safe(p.Logs))
			}
			if p.Notice != "" && p.Notice != lastNotice {
				fmt.Fprintln(stdout, termui.Safe(p.Notice))
				lastNotice = p.Notice
			}
		}, nil)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	retry := make(chan struct{}, 1)
	s := spinner.New(spinner.WithSpinner(spinner.Dot), spinner.WithStyle(termui.Accent))
	m := upgradeMonitor{width: 78, height: 24, viewport: viewport.New(76, 12), spinner: s, start: time.Now(), follow: true, retry: retry, code: 130}
	program := tea.NewProgram(m, tea.WithInput(stdin), tea.WithOutput(stdout), tea.WithContext(ctx))
	done := make(chan upgradeDone, 1)
	go func() {
		code, err := runtime.follow(ctx, state, func(p upgradeProgress) { program.Send(p) }, retry)
		result := upgradeDone{code, err}
		done <- result
		program.Send(result)
	}()
	final, err := program.Run()
	cancel()
	result := <-done
	if err != nil && !errors.Is(err, tea.ErrProgramKilled) && !errors.Is(err, tea.ErrInterrupted) {
		return 1, err
	}
	if model, ok := final.(upgradeMonitor); ok && !model.completed {
		return model.code, nil
	}
	return result.code, result.err
}
func (m upgradeMonitor) Init() tea.Cmd { return m.spinner.Tick }
func (m upgradeMonitor) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	case upgradeDone:
		m.code, m.err, m.completed = msg.code, msg.err, true
		return m, tea.Quit
	case upgradeProgress:
		if msg.Task.ID != "" {
			m.progress.Task = msg.Task
			if created, err := time.Parse(time.RFC3339Nano, msg.Task.CreatedAt); err == nil && created.Before(time.Now()) {
				m.start = created
			}
		}
		m.progress.Notice, m.progress.Retry = termui.Safe(msg.Notice), msg.Retry
		m.logs += termui.Safe(msg.Logs)
		if len(m.logs) > 128<<10 {
			m.logs = string([]rune(m.logs)[len([]rune(m.logs))/2:])
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			m.code = 130
			return m, tea.Quit
		case "esc":
			if m.progress.Retry && m.progress.Task.State == "succeeded" {
				m.code = 1
			}
			return m, tea.Quit
		case "r":
			if m.progress.Retry {
				select {
				case m.retry <- struct{}{}:
				default:
				}
			}
			return m, nil
		case "end":
			m.follow = true
		case "up", "pgup":
			m.follow = false
		}
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
	}
	m.size()
	return m, nil
}
func (m *upgradeMonitor) size() {
	m.viewport.Width = max(1, m.width-4)
	m.viewport.SetContent(ansi.Wrap(m.logs, max(1, m.width-4), ""))
	// 使用同一渲染函数测量非日志内容，状态、长错误和提示换行都会进入预算。
	chrome := lipgloss.Height(m.header()+m.footer()) + 3
	if m.height >= 18 {
		chrome += 2
	}
	m.viewport.Height = max(1, m.height-chrome)
	if m.follow {
		m.viewport.GotoBottom()
	}
}
func (m upgradeMonitor) header() string {
	task := m.progress.Task
	meta := ""
	if task.ID != "" {
		meta = "任务 " + task.ID
	}
	text := termui.Header("面板更新", meta, m.width)
	status := m.spinner.View() + " " + taskStateLabel(task.State)
	if m.completed {
		status = taskStateLabel(task.State)
	}
	text += termui.Fit(status+" · "+taskPhaseLabel(task.Phase)+" · 已用 "+time.Since(m.start).Round(time.Second).String(), m.width) + "\n"
	if task.UpdateSource != "" {
		text += termui.Fit(sourceLabel(task.UpdateSource)+" · "+channelLabel(task.UpdateChannel)+" · "+task.TargetCommit, m.width) + "\n"
	}
	if m.progress.Notice != "" {
		text += termui.Hints(m.progress.Notice, m.width) + "\n"
	}
	return text
}
func (m upgradeMonitor) footer() string {
	hint := "PgUp/PgDn 日志 · End 跟随 · Esc 退出监控 · Ctrl+C 退出"
	if m.progress.Retry {
		hint = "r 重试 · " + hint
	}
	return termui.Hints(hint, m.width) + "\n"
}
func (m upgradeMonitor) View() string {
	logs := m.viewport.View()
	if m.height >= 18 {
		logs = termui.Panel("任务日志", logs, m.width, false)
	}
	text := m.header() + logs + "\n" + m.footer()
	if m.err != nil {
		text += termui.Hints("✗ "+termui.Safe(m.err.Error()), m.width) + "\n"
	}
	return termui.Fit(text, m.width)
}
