package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 会话列表屏：按活动排序分页读取（50/页），行上标运行中（activeRunId）；新建／
// 刷新／加载更多／重命名（服务端回执权威）／删除（409 呈现服务端原因、不做本地
// 清理）／切换模型／登出。重命名与删除为列表内子态。

type listMode int

const (
	listIdle listMode = iota
	listRenaming
	listConfirmDelete
	listConfirmLogout
)

type listState struct {
	sessions      []client.Session
	cursor        int
	hasMore       bool
	nextCursor    string
	loading       bool
	loadErr       string
	mode          listMode
	rename        *lineEditor
	busy          bool // 删除／登出等在途操作
	models        []client.ModelProfile
	modelsErr     string
	modelsPending bool
}

func newListState() listState { return listState{loading: true, modelsPending: true} }

// sessionsLoadedMsg 会话页回填（cursor 非空表示追加页，区分首页与加载更多）。
type sessionsLoadedMsg struct {
	cursor string
	page   client.Page[client.Session]
	err    error
}

func loadSessionsCmd(api API, cursor string) tea.Cmd {
	return func() tea.Msg {
		page, err := api.ListSessionsByActivity(context.Background(), cursor)
		return sessionsLoadedMsg{cursor: cursor, page: page, err: err}
	}
}

// renameDoneMsg 重命名回填。
type renameDoneMsg struct {
	session client.Session
	err     error
}

func renameCmd(api API, id, title string) tea.Cmd {
	return func() tea.Msg {
		session, err := api.RenameSession(context.Background(), id, title)
		return renameDoneMsg{session: session, err: err}
	}
}

// deleteDoneMsg 删除回填（id 供定位行；404 视为已删，同样移除行）。
type deleteDoneMsg struct {
	id  string
	err error
}

func deleteCmd(api API, id string) tea.Cmd {
	return func() tea.Msg {
		return deleteDoneMsg{id: id, err: api.DeleteSession(context.Background(), id)}
	}
}

// logoutDoneMsg 登出回填。
type logoutDoneMsg struct{ err error }

func logoutCmd(api API) tea.Cmd {
	return func() tea.Msg {
		return logoutDoneMsg{err: api.Logout(context.Background())}
	}
}

// current 列表当前光标会话（无会话时 ok=false）。
func (s *listState) current() (client.Session, bool) {
	if s.cursor < 0 || s.cursor >= len(s.sessions) {
		return client.Session{}, false
	}
	return s.sessions[s.cursor], true
}

func (m Model) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if s := &m.list; s.mode == listRenaming {
		return m.updateRename(msg)
	}
	if m.list.mode == listConfirmDelete || m.list.mode == listConfirmLogout {
		return m.updateConfirm(msg)
	}
	if m.list.busy || m.list.loading {
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		if m.list.cursor > 0 {
			m.list.cursor--
		}
	case "down", "j":
		if m.list.cursor < len(m.list.sessions)-1 {
			m.list.cursor++
		}
	case "g":
		m.list.cursor = 0
	case "G":
		if len(m.list.sessions) > 0 {
			m.list.cursor = len(m.list.sessions) - 1
		}
	case "enter":
		session, ok := m.list.current()
		if !ok {
			return m, nil
		}
		return m.enterChat(session.ID)
	case "n":
		m.phase = phasePicker
		m.picker = newPickerState(pickerCreate, m.list.models, "")
		return m, nil
	case "r":
		m.list.loading = true
		m.list.loadErr = ""
		return m, loadSessionsCmd(m.api, "")
	case "l":
		if m.list.hasMore {
			m.list.loading = true
			return m, loadSessionsCmd(m.api, m.list.nextCursor)
		}
	case "t":
		session, ok := m.list.current()
		if !ok {
			return m, nil
		}
		m.list.mode = listRenaming
		m.list.rename = newLineEditor(false)
		m.list.rename.setRunes(session.Title)
		return m, nil
	case "d":
		if session, ok := m.list.current(); ok && m.locals[session.ID].Pending != nil {
			m.notice = "该会话存在未确认提交，请先进入会话核对"
			m.noticeBad = true
			return m, nil
		}
		if _, ok := m.list.current(); !ok {
			return m, nil
		}
		m.list.mode = listConfirmDelete
		return m, nil
	case "m":
		if session, ok := m.list.current(); ok && m.locals[session.ID].Pending != nil {
			m.notice = "提交未确认，不能切换模型"
			m.noticeBad = true
			return m, nil
		}
		session, ok := m.list.current()
		if !ok {
			return m, nil
		}
		m.phase = phasePicker
		m.picker = newPickerState(pickerSwitch, m.list.models, session.ID)
		return m, nil
	case "o":
		m.list.mode = listConfirmLogout
		return m, nil
	case "esc":
		return m, tea.Quit
	}
	return m, nil
}

// updateRename 重命名子态：Enter 提交（本地与服务端同口径预检），Esc 取消。
func (m Model) updateRename(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.list.mode = listIdle
		m.list.rename = nil
		return m, nil
	case "enter":
		title := strings.TrimSpace(m.list.rename.text())
		if err := client.ValidateTitle(title); err != nil {
			m.notice = err.Error()
			m.noticeBad = true
			return m, nil
		}
		session, ok := m.list.current()
		if !ok {
			m.list.mode = listIdle
			return m, nil
		}
		m.list.busy = true
		m.notice = ""
		return m, renameCmd(m.api, session.ID, title)
	default:
		return m, m.list.rename.updateKey(msg)
	}
}

// updateConfirm 删除／登出确认子态：Enter／y 确认，Esc 取消。
func (m Model) updateConfirm(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.list.mode = listIdle
		m.list.busy = false
		return m, nil
	case "enter", "y":
		if m.list.mode == listConfirmDelete {
			session, ok := m.list.current()
			if !ok {
				m.list.mode = listIdle
				m.list.busy = false
				return m, nil
			}
			m.list.busy = true
			return m, deleteCmd(m.api, session.ID)
		}
		m.list.mode = listIdle
		m.list.busy = true
		return m, logoutCmd(m.api)
	default:
		return m, nil
	}
}

// updateSessionsLoaded 会话页数据落地；任何页失败呈现五态错误，401 收敛登录。
func (m Model) updateSessionsLoaded(msg sessionsLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.list.loading = false
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.list.loadErr = errText(msg.err)
		return m, nil
	}
	m.list.loading = false
	m.list.loadErr = ""
	if msg.cursor != "" {
		m.list.sessions = append(m.list.sessions, msg.page.Items...)
	} else {
		m.list.sessions = msg.page.Items
		if m.list.cursor >= len(m.list.sessions) {
			m.list.cursor = max(0, len(m.list.sessions)-1)
		}
	}
	m.list.hasMore = msg.page.HasMore
	m.list.nextCursor = msg.page.NextCursor
	return m, nil
}

// updateRenameDone 重命名以服务端回执为权威更新行。
func (m Model) updateRenameDone(msg renameDoneMsg) (tea.Model, tea.Cmd) {
	m.list.busy = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.notice = "重命名失败：" + errText(msg.err)
		m.noticeBad = true
		m.list.mode = listIdle
		return m, nil
	}
	for i := range m.list.sessions {
		if m.list.sessions[i].ID == msg.session.ID {
			m.list.sessions[i].Title = msg.session.Title
			break
		}
	}
	m.list.mode = listIdle
	m.list.rename = nil
	m.notice = "已重命名"
	m.noticeBad = false
	return m, nil
}

// updateDeleteDone 删除：成功或 404 移除行；409 等拒绝呈现服务端原因、保留行。
func (m Model) updateDeleteDone(msg deleteDoneMsg) (tea.Model, tea.Cmd) {
	m.list.busy = false
	m.list.mode = listIdle
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Status == 404 {
			// 404 视为已删（幂等），同样从列表移除。
		} else {
			m.notice = "删除失败：" + errText(msg.err)
			m.noticeBad = true
			return m, nil
		}
	}
	kept := m.list.sessions[:0]
	for _, session := range m.list.sessions {
		if session.ID != msg.id {
			kept = append(kept, session)
		}
	}
	m.list.sessions = kept
	delete(m.locals, msg.id)
	delete(m.drafts, msg.id)
	delete(m.levels, msg.id)
	delete(m.permModes, msg.id)
	if m.chat.sessionID == msg.id {
		m.chat = chatState{}
	}
	var cmd tea.Cmd = saveStateCmd(m)
	if m.selected == msg.id {
		m.selected = ""
		cmd = saveStateCmd(m)
	}
	if m.list.cursor >= len(m.list.sessions) {
		m.list.cursor = max(0, len(m.list.sessions)-1)
	}
	m.notice = "已删除会话"
	m.noticeBad = false
	return m, cmd
}

// updateLogoutDone 登出：清本地凭据回登录屏；服务端幂等（失败也走本地清理）。
func (m Model) updateLogoutDone(msg logoutDoneMsg) (tea.Model, tea.Cmd) {
	_ = m.deps.ClearCreds()
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			// 会话本身已失效：与正常登出同形。
		} else {
			m.notice = "登出时面板返回：" + errText(msg.err)
			m.noticeBad = true
		}
	}
	if m.api != nil {
		m.api.SetSessionCookie("")
	}
	if m.sub != nil {
		m.sub.close()
		m.sub = nil
	}
	if m.chatCancel != nil {
		m.chatCancel()
	}
	m.bootRestore = false
	m.phase = phaseLogin
	m.login = newLoginState()
	m.list = newListState()
	m.chat = chatState{}
	return m, nil
}

// storedState 收集需要持久化的本地状态：指针、思考档、权限模式与草稿（含未确认提交
// 信封）。
func (m Model) storedState() StoredState {
	m.captureLocal()
	return cloneState(StoredState{Version: 2, Sessions: m.locals, Selected: m.selected, Levels: m.levels, PermissionModes: m.permModes, Drafts: m.drafts})
}

// saveStateCmd 持久化本地指针、思考档、权限模式与草稿。
func saveStateCmd(m Model) tea.Cmd {
	err := m.persist()
	if err == nil {
		return nil
	}
	return func() tea.Msg { return stateSavedMsg{err: err} }
}

// modelsLoadedMsg 模型目录回填。
type modelsLoadedMsg struct {
	profiles []client.ModelProfile
	err      error
}

func loadModelsCmd(api API) tea.Cmd {
	return func() tea.Msg {
		profiles, err := api.ListModelProfiles(context.Background())
		return modelsLoadedMsg{profiles: profiles, err: err}
	}
}

// updateModelsLoaded 模型目录只保留会话可用模型（active＋text＋tools）。
func (m Model) updateModelsLoaded(msg modelsLoadedMsg) (tea.Model, tea.Cmd) {
	m.list.modelsPending = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.list.modelsErr = errText(msg.err)
		return m, nil
	}
	m.list.models = client.ChatModels(msg.profiles)
	m.list.modelsErr = ""
	return m, nil
}

// view 渲染会话列表。
func (s *listState) view(m Model) string {
	var b strings.Builder
	switch {
	case s.loading && len(s.sessions) == 0:
		b.WriteString(metaStyle.Render("正在加载会话…"))
		b.WriteString("\n")
	case s.loadErr != "":
		b.WriteString(warnStyle.Render(truncateCells(s.loadErr, max(20, m.width-2))))
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("r 重试"))
		b.WriteString("\n")
	case len(s.sessions) == 0:
		b.WriteString(metaStyle.Render("暂无会话：按 n 新建"))
		b.WriteString("\n")
	default:
		start, end := listWindow(len(s.sessions), s.cursor, max(1, m.height-9))
		for i := start; i < end; i++ {
			session := s.sessions[i]
			marker := "  "
			if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
				marker = okStyle.Render("● ")
			}
			line := fmt.Sprintf("%s%s · %s · %s", marker, session.Title, modelName(m, session), formatActivity(session.LastActivityAt))
			if i == s.cursor {
				prefix := "❯ "
				if s.mode != listIdle {
					prefix = "  "
				}
				b.WriteString(selectSty.Render(prefix) + selectSty.Render(truncateCells(strings.TrimPrefix(line, marker), max(10, m.width-4))))
			} else {
				b.WriteString("  " + truncateCells(strings.TrimPrefix(line, marker), max(10, m.width-4)))
			}
			b.WriteString("\n")
		}
		if s.hasMore || end < len(s.sessions) || start > 0 {
			b.WriteString(metaStyle.Render("… 按 l 加载更多"))
			b.WriteString("\n")
		}
	}
	if s.mode == listRenaming && s.rename != nil {
		b.WriteString("\n")
		b.WriteString("新标题：" + s.rename.render(max(16, m.width-12), true))
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter 保存 · Esc 取消"))
		b.WriteString("\n")
		return b.String()
	}
	if s.mode == listConfirmDelete {
		session, _ := s.current()
		b.WriteString("\n")
		b.WriteString(dangerSty.Render("确认删除会话「" + truncateCells(session.Title, max(10, m.width-16)) + "」？"))
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter／y 确认删除 · Esc 取消"))
		b.WriteString("\n")
		return b.String()
	}
	if s.mode == listConfirmLogout {
		b.WriteString("\n")
		b.WriteString(warnStyle.Render("确认退出登录？（浏览器会话不受影响）"))
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter／y 确认 · Esc 取消"))
		b.WriteString("\n")
		return b.String()
	}
	b.WriteString("\n")
	b.WriteString(hintStyle.Render("Enter 打开 · n 新建 · r 刷新 · t 重命名 · d 删除 · m 模型 · o 登出 · Esc 返回主菜单"))
	b.WriteString("\n")
	return b.String()
}

// modelName 会话行的模型显示名：目录命中取模型名（任意修订），未命中回 id@rev。
func modelName(m Model, session client.Session) string {
	for _, profile := range m.list.models {
		if profile.ID == session.ModelProfileID {
			return profile.Model
		}
	}
	return fmt.Sprintf("%s@%d", session.ModelProfileID, session.ModelRevision)
}

// formatActivity 活动时间的本地简报（解析失败净化后按显示宽度截断）。
func formatActivity(iso string) string {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSuffix(iso, "Z")+"Z")
	if err != nil {
		return truncateCells(iso, 19)
	}
	return parsed.Local().Format("01-02 15:04")
}
