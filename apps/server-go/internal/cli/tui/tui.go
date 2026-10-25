// Package tui 实现 ely 的 Agent 终端（CLI 方案 §6）：仅经 internal/cli/client
// 消费面板既有 HTTP 接口，本地只持久化凭据与指针，不私建会话存储或权限状态。
// 本阶段（第一步）覆盖连接与登录、会话列表／创建／切换／恢复、模型与思考等级
// 选择及会话运行状态展示；聊天收发尚未接入，界面如实说明，不冒充能力。
package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// API 是 TUI 消费的面板接口（*client.Client 为唯一生产实现；测试注入 fake）。
type API interface {
	BaseURL() string
	SetSessionCookie(cookie string)
	SessionCookie() string
	Login(ctx context.Context, username, password string) error
	ProbeSession(ctx context.Context) (bool, error)
	Logout(ctx context.Context) error
	ListSessionsByActivity(ctx context.Context, cursor string) (client.Page[client.Session], error)
	GetSession(ctx context.Context, id string) (client.Session, error)
	CreateSession(ctx context.Context, input client.CreateSessionInput) (client.Session, error)
	RenameSession(ctx context.Context, id, title string) (client.Session, error)
	DeleteSession(ctx context.Context, id string) error
	SwitchSessionModel(ctx context.Context, id string, input client.SwitchModelInput) (client.Session, error)
	ListModelProfiles(ctx context.Context) ([]client.ModelProfile, error)
	ListSessionTasks(ctx context.Context, sessionID string, limit int) (client.Page[client.Task], error)
	GetRun(ctx context.Context, id string) (client.Run, error)
	ListMessages(ctx context.Context, sessionID, after string) (client.Page[client.Message], error)
	CreateTask(ctx context.Context, sessionID string, input client.AgentInput) (client.Run, error)
	ContinueTask(ctx context.Context, taskID string, input client.AgentInput) (client.Run, error)
	CancelRun(ctx context.Context, runID string) (client.Run, error)
	TimelineSnapshot(ctx context.Context, runID string) (client.ChatTimeline, error)
	ListApprovalsByRun(ctx context.Context, runID string) ([]client.Approval, error)
	DecideApproval(ctx context.Context, id, decision string) (client.Approval, error)
	DecideAccess(ctx context.Context, id string, input client.AccessDecisionInput) (client.Approval, error)
	ListSessionAuthorizations(ctx context.Context, sessionID string) ([]client.SessionAuthorization, error)
	RevokeSessionAuthorization(ctx context.Context, sessionID, authorizationID string, input client.RevokeAuthorizationInput) error
	AnswerUserInput(ctx context.Context, runID, inputID string, input client.AnswerUserInputInput) (client.UserInputReceipt, error)
	ListCalls(ctx context.Context, runID, cursor string) (client.Page[client.Call], error)
	// StreamChatOutput 建立一次 SSE 连接逐帧回调全量快照；契约见 client 包。
	StreamChatOutput(ctx context.Context, runID string, onOutput func(client.ChatOutput) error) error
}

// Deps 是 TUI 的可注入出口：后端发现、HTTP 客户端构造与本地凭据／指针持久化全部
// 经函数注入，保持 tui 包对 cli 根包零依赖（cli 根包装配生产实现）。
type Deps struct {
	// Discover 解析并探测面板后端，返回 baseURL；错误应为 *client.Error（五态分类）。
	Discover func(ctx context.Context) (string, error)
	// Dial 构造指定后端的 API 客户端。
	Dial func(baseURL string) API
	// LoadCreds／SaveCreds／ClearCreds 本地凭据（baseURL＋Cookie）存取。
	LoadCreds  func() (baseURL, cookie string, err error)
	SaveCreds  func(baseURL, cookie string) error
	ClearCreds func() error
	// LoadState／SaveState 本地指针（上次选中会话、每会话思考档／权限模式与输入草稿）。
	LoadState func() StoredState
	SaveState func(StoredState) error
}

// phase 屏幕状态机：boot（探测判活）→ 登录或会话列表；列表进入新建向导／切换
// 模型向导／会话详情。
type phase int

const (
	phaseBoot phase = iota
	phaseConnError
	phaseLogin
	phaseSessions
	phasePicker
	phaseSession
)

// bootMsg bootCmd 的结果：探测失败（五态错误）／需登录／就绪。
type bootMsg struct {
	baseURL   string
	api       API
	needLogin bool
	err       error
}

// Model 是 Agent 终端的 bubbletea 模型；Update 为纯状态机，全部网络与文件 IO 经
// tea.Cmd 异步执行。
type Model struct {
	deps    Deps
	phase   phase
	api     API
	baseURL string
	width   int
	height  int

	connErr *client.Error

	login    loginState
	list     listState
	picker   pickerState
	chat     chatState
	sub      *streamSub
	markdown *markdownRenderer

	selected  string            // 本地指针：上次进入的会话
	levels    map[string]string // 每会话思考档选择（逐轮提交时消费）
	permModes map[string]string // 每会话权限模式选择（逐轮提交时消费；缺省 ask）
	drafts    map[string]string // 每会话输入草稿

	notice    string // 全局提示行（操作结果／错误）
	noticeBad bool
}

// StoredState 是 TUI 持久化状态的本地形状（凭据之外的用户态）。
type StoredState struct {
	Selected        string
	Levels          map[string]string
	PermissionModes map[string]string
	Drafts          map[string]string
}

// New 构造初始模型（boot 起步）。
func New(deps Deps) Model {
	return Model{deps: deps, phase: phaseBoot, levels: map[string]string{}, permModes: map[string]string{}, drafts: map[string]string{}, markdown: newMarkdownRenderer(78)}
}

// chatViewportHeight 消息区高度：总高减头部／断连行余量／输入区／帮助行。
func chatViewportHeight(height int) int {
	return max(4, height-9)
}

// Run 启动 Agent 终端程序；错误由菜单层提示。Ctrl+C／Esc 退出均为正常返回。
func Run(stdin *os.File, stdout io.Writer, deps Deps) error {
	program := tea.NewProgram(New(deps), tea.WithInput(stdin), tea.WithOutput(stdout))
	_, err := program.Run()
	if errors.Is(err, tea.ErrInterrupted) || errors.Is(err, tea.ErrProgramKilled) {
		return nil
	}
	return err
}

// bootCmd 探测面板＋读取本地凭据＋被动判活，一条命令完成避免中间态闪烁。
func bootCmd(deps Deps) tea.Cmd {
	return func() tea.Msg {
		ctx := context.Background()
		baseURL, err := deps.Discover(ctx)
		if err != nil {
			return bootMsg{err: err}
		}
		api := deps.Dial(baseURL)
		_, cookie, credErr := deps.LoadCreds()
		if credErr != nil || cookie == "" {
			return bootMsg{baseURL: baseURL, api: api, needLogin: true}
		}
		api.SetSessionCookie(cookie)
		authenticated, probeErr := api.ProbeSession(ctx)
		if probeErr != nil {
			var connErr *client.Error
			if errors.As(probeErr, &connErr) && connErr.Kind == client.KindUnauthorized {
				_ = deps.ClearCreds()
			}
			return bootMsg{baseURL: baseURL, api: api, err: probeErr}
		}
		if !authenticated {
			_ = deps.ClearCreds()
			return bootMsg{baseURL: baseURL, api: api, needLogin: true}
		}
		return bootMsg{baseURL: baseURL, api: api}
	}
}

func (m Model) Init() tea.Cmd { return bootCmd(m.deps) }

// Update 消息总分发：WindowSize 先行，各屏按键与异步结果按 phase 路由。
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.markdown = newMarkdownRenderer(max(16, m.width-2))
		if m.phase == phaseSession {
			m.chat.viewport.Width = max(16, m.width-2)
			m.chat.viewport.Height = chatViewportHeight(m.height)
			m.chat.editor.SetWidth(max(16, m.width-4))
			m.applyRender()
		}
		return m, nil
	case bootMsg:
		return m.updateBoot(msg)
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		switch m.phase {
		case phaseLogin:
			return m.updateLogin(msg)
		case phaseSessions:
			return m.updateList(msg)
		case phasePicker:
			return m.updatePicker(msg)
		case phaseSession:
			return m.updateChatKeys(msg)
		case phaseConnError:
			switch msg.String() {
			case "r":
				m.phase = phaseBoot
				m.connErr = nil
				return m, bootCmd(m.deps)
			case "esc":
				return m, tea.Quit
			}
		}
		return m, nil
	case loginDoneMsg:
		return m.updateLoginDone(msg)
	case sessionsLoadedMsg:
		return m.updateSessionsLoaded(msg)
	case modelsLoadedMsg:
		return m.updateModelsLoaded(msg)
	case sessionCreatedMsg:
		return m.updateSessionCreated(msg)
	case modelSwitchedMsg:
		return m.updateModelSwitched(msg)
	case renameDoneMsg:
		return m.updateRenameDone(msg)
	case deleteDoneMsg:
		return m.updateDeleteDone(msg)
	case chatLoadedMsg:
		return m.updateChatLoaded(msg)
	case streamFrameMsg:
		return m.updateStreamFrame(msg)
	case streamInterruptedMsg:
		return m.updateStreamInterrupted()
	case streamEndedMsg:
		return m.updateStreamEnded()
	case streamDeadMsg:
		return m.updateStreamDead(msg)
	case submitMsg:
		return m.updateSubmit(msg)
	case pollMsg:
		return m.updatePoll(msg)
	case cancelMsg:
		return m.updateCancel(msg)
	case messagesAppendedMsg:
		return m.updateMessagesAppended(msg)
	case approvalsMsg:
		return m.updateApprovals(msg)
	case approvalDecisionMsg:
		return m.updateApprovalDecision(msg)
	case authorizationsMsg:
		return m.updateAuthorizations(msg)
	case revokeAuthMsg:
		return m.updateRevokeAuth(msg)
	case userInputAnswerMsg:
		return m.updateUserInputAnswer(msg)
	case callsMsg:
		return m.updateCalls(msg)
	case chatRenderMsg:
		if m.phase == phaseSession {
			m.applyRender()
			return m, nil
		}
		return m, nil
	case logoutDoneMsg:
		return m.updateLogoutDone(msg)
	}
	return m, nil
}

// updateBoot boot 结果分派：探测失败进连接错误屏；需登录进登录屏；就绪加载目录
// 与列表并按本地指针恢复。
func (m Model) updateBoot(msg bootMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.phase = phaseConnError
		var connErr *client.Error
		if errors.As(msg.err, &connErr) {
			m.connErr = connErr
		} else {
			m.connErr = &client.Error{Kind: client.KindUnreachable, Message: msg.err.Error()}
		}
		return m, nil
	}
	m.api = msg.api
	m.baseURL = msg.baseURL
	if msg.needLogin {
		m.phase = phaseLogin
		m.login = newLoginState()
		return m, nil
	}
	m.phase = phaseSessions
	m.list = newListState()
	if state := m.deps.LoadState(); state.Selected != "" || len(state.Levels) > 0 || len(state.PermissionModes) > 0 || len(state.Drafts) > 0 {
		if state.Selected != "" {
			m.selected = state.Selected
		}
		if state.Levels != nil {
			m.levels = state.Levels
		}
		if state.PermissionModes != nil {
			m.permModes = state.PermissionModes
		}
		if state.Drafts != nil {
			m.drafts = state.Drafts
		}
	}
	m.chat = newChatState(m.selected)
	cmds := []tea.Cmd{loadModelsCmd(m.api), loadSessionsCmd(m.api, "")}
	if m.selected != "" {
		cmds = append(cmds, loadChatCmd(m.api, m.selected))
	}
	return m, tea.Batch(cmds...)
}

// handleUnauthorized 五态无权限态的统一收敛：停聊天订阅与轮询、清本地凭据、回登录屏。
func (m *Model) handleUnauthorized(reason string) {
	if m.sub != nil {
		m.sub.close()
		m.sub = nil
	}
	m.chat.polling = false
	m.chat.sending = false
	_ = m.deps.ClearCreds()
	if m.api != nil {
		m.api.SetSessionCookie("")
	}
	m.phase = phaseLogin
	m.login = newLoginState()
	m.notice = reason
	m.noticeBad = true
}

// asClientErr 提取 *client.Error。
func asClientErr(err error) *client.Error {
	var connErr *client.Error
	if errors.As(err, &connErr) {
		return connErr
	}
	return nil
}

// errText 错误呈现：服务端中文消息＋五态提示。
func errText(err error) string {
	if connErr := asClientErr(err); connErr != nil {
		parts := []string{connErr.Message}
		if connErr.RetryAfter > 0 {
			parts = append(parts, fmt.Sprintf("请在 %d 秒后重试", connErr.RetryAfter))
		}
		if connErr.Hint != "" && connErr.Kind != client.KindUnauthorized {
			parts = append(parts, connErr.Hint)
		}
		return strings.Join(parts, "；")
	}
	return err.Error()
}

// View 总分发：连接错误屏与提示行常驻，其余按 phase。
func (m Model) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("Agent 终端"))
	if m.baseURL != "" {
		b.WriteString(metaStyle.Render("　" + m.baseURL))
	}
	b.WriteString("\n")
	if m.phase == phaseConnError {
		b.WriteString("\n")
		if m.connErr != nil {
			b.WriteString(warnStyle.Render(truncateCells(m.connErr.Message, max(48, m.width-2))))
			b.WriteString("\n")
			if m.connErr.Hint != "" {
				b.WriteString(metaStyle.Render(truncateCells(m.connErr.Hint, max(48, m.width-2))))
				b.WriteString("\n")
			}
		}
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("r 重试 · Esc 返回主菜单 · Ctrl+C 退出"))
		b.WriteString("\n")
		return b.String()
	}
	switch m.phase {
	case phaseBoot:
		b.WriteString(metaStyle.Render("正在连接面板…"))
		b.WriteString("\n")
	case phaseLogin:
		b.WriteString(m.login.view(m))
	case phaseSessions:
		b.WriteString(m.list.view(m))
	case phasePicker:
		b.WriteString(m.picker.view(m))
	case phaseSession:
		b.WriteString(m.chat.view(m))
	}
	if m.notice != "" {
		style := metaStyle
		if m.noticeBad {
			style = warnStyle
		}
		b.WriteString("\n")
		b.WriteString(style.Render(truncateCells(m.notice, max(20, m.width-2))))
		b.WriteString("\n")
	}
	return b.String()
}

// 样式：与主菜单同款的中性表达（NO_COLOR／非彩色终端自动降级纯文本）。
var (
	titleStyle = lipgloss.NewStyle().Bold(true)
	metaStyle  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "8", Dark: "8"})
	hintStyle  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "8", Dark: "8"})
	warnStyle  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "3", Dark: "11"})
	dangerSty  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "1", Dark: "9"})
	selectSty  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.AdaptiveColor{Light: "12", Dark: "14"})
	okStyle    = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "2", Dark: "10"})
)

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
