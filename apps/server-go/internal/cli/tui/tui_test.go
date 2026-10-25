package tui

import (
	"context"
	"errors"
	"github.com/charmbracelet/bubbles/cursor"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// TUI 状态机纯函数测试：fake API 与函数式 Deps 注入，逐消息驱动 Update，不启动
// bubbletea 程序、不发真实网络。覆盖 boot 恢复链、登录、会话列表操作、新建／
// 切换模型向导、会话详情运行失败态与 401 收敛。

// fakeAPI 按字段编排响应。
type fakeAPI struct {
	cookie string

	loginErr    error
	probeAuth   bool
	probeErr    error
	logoutErr   error
	sessions    []client.Session
	sessionsErr error
	session     client.Session
	sessionErr  error
	created     client.Session
	createErr   error
	renamed     client.Session
	renameErr   error
	deleted     []string
	deleteErr   error
	switched    client.Session
	switchErr   error
	profiles    []client.ModelProfile
	profilesErr error
	tasks       []client.Task

	messages    []client.Message
	messagesErr error
	// listMessagesOverride 分页桩（按调用次序回放预置页）。
	listMessagesOverride func(sessionID, after string) (client.Page[client.Message], error)
	nextRun              client.Run
	createTaskErr        error
	continueErr          error
	cancelErr            error
	timeline             *client.ChatTimeline
	streamFrames         []client.ChatOutput
	streamErr            error
	// streamCalls 计数并发流连接（多个 openStream goroutine 同时回调，需原子递增）。
	streamCalls atomic.Int32

	submittedInputs []client.AgentInput

	approvals      []client.Approval
	approvalsErr   error
	decided        []string
	decideErr      error
	accessDecided  []client.AccessDecisionInput
	accessErr      error
	authorizations []client.SessionAuthorization
	authErr        error
	revoked        []string
	revokeErr      error
	answerReceipt  *client.UserInputReceipt
	answerErr      error
	answerInputs   []client.AnswerUserInputInput
	callsPage      client.Page[client.Call]
	callsErr       error
	switchInput    *client.SwitchModelInput
	createInput    *client.CreateSessionInput
}

func (f *fakeAPI) BaseURL() string                { return "http://127.0.0.1:48101" }
func (f *fakeAPI) SetSessionCookie(cookie string) { f.cookie = cookie }
func (f *fakeAPI) SessionCookie() string          { return f.cookie }
func (f *fakeAPI) Login(_ context.Context, _, _ string) error {
	if f.loginErr == nil {
		f.cookie = "cli-cookie"
	}
	return f.loginErr
}
func (f *fakeAPI) ProbeSession(context.Context) (bool, error) { return f.probeAuth, f.probeErr }
func (f *fakeAPI) Logout(context.Context) error               { f.cookie = ""; return f.logoutErr }
func (f *fakeAPI) ListSessionsByActivity(_ context.Context, cursor string) (client.Page[client.Session], error) {
	if f.sessionsErr != nil {
		return client.Page[client.Session]{}, f.sessionsErr
	}
	if cursor == "" {
		return client.Page[client.Session]{Items: f.sessions}, nil
	}
	// 追加页：按 ID 字典序返回 cursor 之后的会话（真实服务端为不透明游标）。
	items := make([]client.Session, 0, len(f.sessions))
	for _, session := range f.sessions {
		if session.ID > cursor {
			items = append(items, session)
		}
	}
	return client.Page[client.Session]{Items: items}, nil
}
func (f *fakeAPI) GetSession(_ context.Context, id string) (client.Session, error) {
	if f.sessionErr != nil {
		return client.Session{}, f.sessionErr
	}
	for _, session := range f.sessions {
		if session.ID == id {
			return session, nil
		}
	}
	if f.session.ID == "" {
		f.session = client.Session{ID: id, Title: "会话 " + id, ModelProfileID: "p1", ModelRevision: 1}
	}
	return f.session, nil
}
func (f *fakeAPI) CreateSession(_ context.Context, input client.CreateSessionInput) (client.Session, error) {
	if f.createErr != nil {
		return client.Session{}, f.createErr
	}
	f.createInput = &input
	if f.created.ID == "" {
		f.created = client.Session{ID: "new-1", Title: input.Title, ModelProfileID: input.ModelProfileID, ModelRevision: input.ModelRevision}
	}
	return f.created, nil
}
func (f *fakeAPI) RenameSession(_ context.Context, id, _ string) (client.Session, error) {
	if f.renameErr != nil {
		return client.Session{}, f.renameErr
	}
	return client.Session{ID: id, Title: "改名后"}, nil
}
func (f *fakeAPI) DeleteSession(_ context.Context, id string) error {
	f.deleted = append(f.deleted, id)
	return f.deleteErr
}
func (f *fakeAPI) SwitchSessionModel(_ context.Context, id string, input client.SwitchModelInput) (client.Session, error) {
	if f.switchErr != nil {
		return client.Session{}, f.switchErr
	}
	f.switchInput = &input
	if f.switched.ID == "" {
		f.switched = client.Session{ID: id}
	}
	f.switched.ModelProfileID = input.ModelProfileID
	f.switched.ModelRevision = input.ModelRevision
	return f.switched, nil
}
func (f *fakeAPI) ListModelProfiles(context.Context) ([]client.ModelProfile, error) {
	return f.profiles, f.profilesErr
}
func (f *fakeAPI) ListSessionTasks(_ context.Context, _ string, _ int) (client.Page[client.Task], error) {
	return client.Page[client.Task]{Items: f.tasks}, nil
}
func (f *fakeAPI) GetRun(_ context.Context, id string) (client.Run, error) {
	if f.nextRun.ID != "" {
		return f.nextRun, nil
	}
	return client.Run{ID: id}, nil
}

// ListMessages 按 after 过滤升序消息（分页桩优先；缺省单页全量）。序号过滤与
// 实现同口径数值化比较（seq 为十进制数字字符串，字典序会丢跨十进制位数的增量）。
func (f *fakeAPI) ListMessages(_ context.Context, sessionID, after string) (client.Page[client.Message], error) {
	if f.listMessagesOverride != nil {
		return f.listMessagesOverride(sessionID, after)
	}
	if f.messagesErr != nil {
		return client.Page[client.Message]{}, f.messagesErr
	}
	items := make([]client.Message, 0, len(f.messages))
	for _, message := range f.messages {
		if seqGreater(message.Seq, after) {
			items = append(items, message)
		}
	}
	return client.Page[client.Message]{Items: items}, nil
}

func (f *fakeAPI) CreateTask(_ context.Context, sessionID string, input client.AgentInput) (client.Run, error) {
	f.submittedInputs = append(f.submittedInputs, input)
	if f.createTaskErr != nil {
		return client.Run{}, f.createTaskErr
	}
	if f.nextRun.ID == "" {
		f.nextRun = client.Run{ID: "run-new", TaskID: "task-new", SessionID: sessionID, Status: "running"}
	}
	return f.nextRun, nil
}

func (f *fakeAPI) ContinueTask(_ context.Context, taskID string, input client.AgentInput) (client.Run, error) {
	f.submittedInputs = append(f.submittedInputs, input)
	if f.continueErr != nil {
		return client.Run{}, f.continueErr
	}
	if f.nextRun.ID == "" {
		f.nextRun = client.Run{ID: "run-next", TaskID: taskID, Status: "running"}
	}
	return f.nextRun, nil
}

func (f *fakeAPI) CancelRun(_ context.Context, runID string) (client.Run, error) {
	if f.cancelErr != nil {
		return client.Run{}, f.cancelErr
	}
	return client.Run{ID: runID, Status: "cancelled", EndReason: "cancelled"}, nil
}

func (f *fakeAPI) TimelineSnapshot(_ context.Context, runID string) (client.ChatTimeline, error) {
	if f.timeline != nil {
		return *f.timeline, nil
	}
	return client.ChatTimeline{RunID: runID, Status: "running", Entries: []client.TimelineEntry{}}, nil
}

// StreamChatOutput 逐帧回调预置帧后自然结束（连接结束语义）。
func (f *fakeAPI) StreamChatOutput(_ context.Context, _ string, onOutput func(client.ChatOutput) error) error {
	f.streamCalls.Add(1)
	if f.streamErr != nil {
		return f.streamErr
	}
	for _, frame := range f.streamFrames {
		if err := onOutput(frame); err != nil {
			return err
		}
	}
	return nil
}

// —— 审批／授权／等待输入／calls 的 fake 实现 ——

func (f *fakeAPI) ListApprovalsByRun(context.Context, string) ([]client.Approval, error) {
	if f.approvalsErr != nil {
		return nil, f.approvalsErr
	}
	return visibleApprovals(f.approvals), nil
}

func (f *fakeAPI) DecideApproval(_ context.Context, id, decision string) (client.Approval, error) {
	f.decided = append(f.decided, id+":"+decision)
	if f.decideErr != nil {
		return client.Approval{}, f.decideErr
	}
	for _, item := range f.approvals {
		if item.ID == id {
			item.Status = decision
			item.Decision = decision
			return item, nil
		}
	}
	return client.Approval{ID: id, Status: decision}, nil
}

func (f *fakeAPI) DecideAccess(_ context.Context, id string, input client.AccessDecisionInput) (client.Approval, error) {
	f.accessDecided = append(f.accessDecided, input)
	if f.accessErr != nil {
		return client.Approval{}, f.accessErr
	}
	for _, item := range f.approvals {
		if item.ID == id {
			item.Status = "approved"
			if input.Decision == "denied" {
				item.Status = "denied"
			}
			return item, nil
		}
	}
	return client.Approval{ID: id}, nil
}

func (f *fakeAPI) ListSessionAuthorizations(context.Context, string) ([]client.SessionAuthorization, error) {
	return f.authorizations, f.authErr
}

func (f *fakeAPI) RevokeSessionAuthorization(_ context.Context, _, id string, _ client.RevokeAuthorizationInput) error {
	f.revoked = append(f.revoked, id)
	return f.revokeErr
}

func (f *fakeAPI) AnswerUserInput(_ context.Context, _, _ string, input client.AnswerUserInputInput) (client.UserInputReceipt, error) {
	f.answerInputs = append(f.answerInputs, input)
	if f.answerErr != nil {
		return client.UserInputReceipt{}, f.answerErr
	}
	if f.answerReceipt != nil {
		return *f.answerReceipt, nil
	}
	return client.UserInputReceipt{Run: client.Run{ID: "r-run", Status: "queued"}}, nil
}

func (f *fakeAPI) ListCalls(context.Context, string, string) (client.Page[client.Call], error) {
	return f.callsPage, f.callsErr
}

// fakeDeps 记录持久化调用。
type fakeDeps struct {
	api      *fakeAPI
	discover func(ctx context.Context) (string, error)

	savedCreds   []string
	clearedCreds int
	savedStates  []StoredState
	loadState    func() StoredState
}

func (d *fakeDeps) deps() Deps {
	return Deps{
		Discover: d.discover,
		Dial:     func(string) API { return d.api },
		LoadCreds: func() (string, string, error) {
			if d.api.cookie != "" {
				return "http://127.0.0.1:48444", d.api.cookie, nil
			}
			return "", "", nil
		},
		SaveCreds: func(baseURL, cookie string) error {
			d.savedCreds = append(d.savedCreds, baseURL+"|"+cookie)
			return nil
		},
		ClearCreds: func() error { d.clearedCreds++; return nil },
		LoadState: func() StoredState {
			if d.loadState != nil {
				return d.loadState()
			}
			return StoredState{}
		},
		SaveState: func(state StoredState) error {
			d.savedStates = append(d.savedStates, state)
			return nil
		},
	}
}

func okDiscover(context.Context) (string, error) { return "http://127.0.0.1:48101", nil }

// runCmd 同步执行一条命令并把消息喂回模型（值语义取回）。
func runCmd(t *testing.T, m Model, cmd tea.Cmd) Model {
	t.Helper()
	if cmd == nil {
		return m
	}
	msg := cmd()
	if msg == nil {
		return m
	}
	plain := msg
	if scoped, ok := msg.(scopedMsg); ok {
		plain = scoped.msg
	}
	if _, ok := plain.(cursor.BlinkMsg); ok {
		return m
	}
	return step(t, m, msg)
}

// step 驱动一条消息并顺带执行其产生的命令。
func step(t *testing.T, m Model, msg tea.Msg) Model {
	t.Helper()
	next, cmd := m.Update(msg)
	model, ok := next.(Model)
	if !ok {
		t.Fatalf("模型应保持值语义，得到 %T", next)
	}
	return runCmd(t, model, cmd)
}

// key 便捷构造字符键。
func key(s string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)} }

var (
	keyEnter = tea.KeyMsg{Type: tea.KeyEnter}
	keyEsc   = tea.KeyMsg{Type: tea.KeyEsc}
	keyDown  = tea.KeyMsg{Type: tea.KeyDown}
	keyTab   = tea.KeyMsg{Type: tea.KeyTab}
)

// bootReady 就绪链：探测＋本地凭据判活＋列表与模型目录加载全通。
func bootReady(t *testing.T, api *fakeAPI, sessions []client.Session, profiles []client.ModelProfile) Model {
	t.Helper()
	return bootReadyWithDeps(t, &fakeDeps{api: api, discover: okDiscover}, api, sessions, profiles)
}

// bootReadyWithDeps 同 bootReady，但允许注入 deps（断言持久化副作用或预置回读状态）。
func bootReadyWithDeps(t *testing.T, deps *fakeDeps, api *fakeAPI, sessions []client.Session, profiles []client.ModelProfile) Model {
	t.Helper()
	api.probeAuth = true
	api.cookie = "stored-cookie"
	api.sessions = sessions
	api.profiles = profiles
	model := New(deps.deps())
	model = step(t, model, tea.WindowSizeMsg{Width: 100, Height: 40})
	model = runCmd(t, model, model.Init())
	if model.phase != phaseSessions {
		t.Fatalf("就绪后应进会话列表，得到 phase=%d", model.phase)
	}
	model = runCmd(t, model, loadSessionsCmd(api, ""))
	model = runCmd(t, model, loadModelsCmd(api))
	return model
}

// pickerModels 向导用模型目录（一个带档位、一个不带）。
func pickerModels() []client.ModelProfile {
	return []client.ModelProfile{
		{ID: "p1", Revision: 1, Model: "带档位", Active: true, Capabilities: client.ModelCapabilities{Text: true, Tools: true, ReasoningLevels: []string{"low", "high", "max"}, DefaultReasoningLevel: "max"}},
		{ID: "p2", Revision: 2, Model: "无档位", Active: true, Capabilities: client.ModelCapabilities{Text: true, Tools: true}},
	}
}

func TestBootConnErrorShowsRecoveryHint(t *testing.T) {
	probes := 0
	deps := &fakeDeps{api: &fakeAPI{}, discover: func(context.Context) (string, error) {
		probes++
		return "", &client.Error{Kind: client.KindNotRunning, Message: "面板后端连接被拒绝", Hint: client.HintFor(client.KindNotRunning)}
	}}
	model := New(deps.deps())
	model = step(t, model, tea.WindowSizeMsg{Width: 100, Height: 40})
	model = runCmd(t, model, model.Init())
	if model.phase != phaseConnError {
		t.Fatalf("探测失败应进连接错误屏：%d", model.phase)
	}
	if view := model.View(); !strings.Contains(view, "systemctl start elysian") {
		t.Fatalf("未启动态应展示启动指引：%q", view)
	}
	model = step(t, model, key("r"))
	if probes != 2 {
		t.Fatalf("r 应触发重新探测，探测了 %d 次", probes)
	}
	if model.phase != phaseConnError {
		t.Fatalf("重试后仍失败应停留错误屏：%d", model.phase)
	}
}

func TestBootStaleCookieClearsAndFallsToLogin(t *testing.T) {
	api := &fakeAPI{probeAuth: false}
	api.cookie = "stale"
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	if model.phase != phaseLogin {
		t.Fatalf("凭据失效应回登录屏：%d", model.phase)
	}
	if deps.clearedCreds != 1 {
		t.Fatalf("失效凭据应清除本地存储，清了 %d 次", deps.clearedCreds)
	}
}

func TestLoginFlowSavesCredsAndEntersSessions(t *testing.T) {
	api := &fakeAPI{}
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	if model.phase != phaseLogin {
		t.Fatalf("无凭据应进登录屏：%d", model.phase)
	}
	model = step(t, model, keyTab)
	model = step(t, model, key("pw123456"))
	model = step(t, model, keyEnter) // 提交（step 顺带执行登录命令并回填）
	if model.phase != phaseSessions {
		t.Fatalf("登录成功应进会话列表：%d", model.phase)
	}
	if len(deps.savedCreds) != 1 || !strings.Contains(deps.savedCreds[0], "cli-cookie") {
		t.Fatalf("登录成功应保存凭据：%v", deps.savedCreds)
	}
}

func TestLoginEmptyFieldsBlockedLocally(t *testing.T) {
	api := &fakeAPI{}
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	// 用户名清空后直接提交：本地拦截，不发请求。
	model = step(t, model, tea.KeyMsg{Type: tea.KeyCtrlU})
	model = step(t, model, keyEnter)
	if !strings.Contains(model.login.error, "请输入用户名与密码") {
		t.Fatalf("空字段应本地拦截：%q", model.login.error)
	}
	if api.cookie != "" {
		t.Fatal("本地拦截不应发起登录")
	}
}

func TestLoginFailureShowsServerMessage(t *testing.T) {
	api := &fakeAPI{loginErr: &client.Error{Kind: client.KindUnauthorized, Status: 401, Message: "用户名或密码错误"}}
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	model = step(t, model, keyTab)
	model = step(t, model, key("bad"))
	model = step(t, model, keyEnter)
	if !strings.Contains(model.login.error, "用户名或密码错误") {
		t.Fatalf("失败应显示服务端消息：%q", model.login.error)
	}
	if model.phase != phaseLogin || model.login.busy {
		t.Fatal("失败后应停留在登录屏并解除忙碌")
	}
}

func TestSessionListEnterSavesPointerAndOpensView(t *testing.T) {
	api := &fakeAPI{}
	sessions := []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1, LastActivityAt: "2026-10-25T08:00:00.000Z"}}
	model := bootReady(t, api, sessions, pickerModels())
	model = step(t, model, keyEnter)
	if model.phase != phaseSession || model.selected != "s1" {
		t.Fatalf("Enter 应进入会话并记指针：phase=%d selected=%q", model.phase, model.selected)
	}
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	if view := model.View(); !strings.Contains(view, "巡检") {
		t.Fatalf("聊天屏头部应展示会话标题：%q", view)
	}
}

func TestSessionListUnauthorizedFallsToLogin(t *testing.T) {
	api := &fakeAPI{sessionsErr: &client.Error{Kind: client.KindUnauthorized, Status: 401, Message: "未登录"}}
	model := bootReady(t, api, nil, nil)
	model = runCmd(t, model, loadSessionsCmd(api, ""))
	if model.phase != phaseLogin {
		t.Fatalf("401 应收敛登录屏：%d", model.phase)
	}
	if !strings.Contains(model.notice, "重新登录") {
		t.Fatalf("被顶提示应指明重登：%q", model.notice)
	}
}

func TestDeleteConflictKeepsRowAndShowsReason(t *testing.T) {
	api := &fakeAPI{deleteErr: &client.Error{Kind: client.KindServer, Status: 409, Message: "会话存在结果未确认的执行，不能删除"}}
	sessions := []client.Session{{ID: "s1", Title: "忙碌", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, key("d"))
	if model.list.mode != listConfirmDelete {
		t.Fatal("d 应进入删除确认子态")
	}
	model = step(t, model, keyEnter)
	model = runCmd(t, model, deleteCmd(api, "s1"))
	if len(model.list.sessions) != 1 {
		t.Fatalf("409 不应本地清理：%+v", model.list.sessions)
	}
	if !strings.Contains(model.notice, "结果未确认") {
		t.Fatalf("应呈现服务端原因：%q", model.notice)
	}
}

func TestDeleteSuccessRemovesRow(t *testing.T) {
	api := &fakeAPI{}
	sessions := []client.Session{
		{ID: "s1", Title: "一", ModelProfileID: "p1", ModelRevision: 1},
		{ID: "s2", Title: "二", ModelProfileID: "p1", ModelRevision: 1},
	}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, key("d"))
	model = step(t, model, keyEnter) // 确认删除光标行（s1）
	if len(model.list.sessions) != 1 || model.list.sessions[0].ID != "s2" {
		t.Fatalf("删除成功应移除当前行：%+v", model.list.sessions)
	}
	if len(api.deleted) != 1 || api.deleted[0] != "s1" {
		t.Fatalf("应对服务端发起一次删除：%v", api.deleted)
	}
}

func TestRenameValidatesLocallyAndUsesServerReceipt(t *testing.T) {
	api := &fakeAPI{}
	sessions := []client.Session{{ID: "s1", Title: "旧标题", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, key("t"))
	if model.list.mode != listRenaming {
		t.Fatal("t 应进入重命名子态")
	}
	// 清空预填后提交：本地预检拦截。
	model.list.rename.setRunes("")
	next, cmd := model.Update(keyEnter)
	model = runCmd(t, next.(Model), cmd)
	if !strings.Contains(model.notice, "不能为空") {
		t.Fatalf("空标题应本地拦截：%q", model.notice)
	}
	// 合法标题：提交并以服务端回执更新行。
	model.list.rename.setRunes("新标题")
	next, cmd = model.Update(keyEnter)
	model = runCmd(t, next.(Model), cmd)
	if model.list.sessions[0].Title != "改名后" {
		t.Fatalf("标题应以服务端回执为权威：%q", model.list.sessions[0].Title)
	}
}

func TestCreateSessionWizardRecordsReasoningLevel(t *testing.T) {
	api := &fakeAPI{created: client.Session{ID: "new-1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, nil, pickerModels())
	model = step(t, model, key("n"))
	if model.phase != phasePicker || model.picker.step != stepTitle {
		t.Fatalf("n 应进入新建标题步：phase=%d", model.phase)
	}
	model = step(t, model, key("巡检"))
	model = step(t, model, keyEnter)
	if model.picker.step != stepModel {
		t.Fatal("标题 Enter 应进入模型步")
	}
	model = step(t, model, keyEnter)
	if model.picker.step != stepLevel {
		t.Fatal("带档位模型应进入档位步")
	}
	if model.picker.level != 2 {
		t.Fatalf("默认档应预选声明档（max 索引 2），得到 %d", model.picker.level)
	}
	model = step(t, model, keyEnter)
	if model.phase != phaseSession || model.chat.sessionID != "new-1" {
		t.Fatalf("创建成功应进入会话详情：phase=%d", model.phase)
	}
	if model.levels["new-1"] != "max" {
		t.Fatalf("向导选择的思考档应按会话记录：%v", model.levels)
	}
	if api.createInput == nil || api.createInput.ModelProfileID != "p1" || api.createInput.ModelRevision != 1 {
		t.Fatalf("创建请求应携带所选模型修订：%+v", api.createInput)
	}
}

func TestCreateSessionNoModelsHonestNotice(t *testing.T) {
	api := &fakeAPI{}
	model := bootReady(t, api, nil, nil)
	model = step(t, model, key("n"))
	model = step(t, model, keyEnter) // 标题留空 → 模型步
	if view := model.View(); !strings.Contains(view, "没有可用的模型") || !strings.Contains(view, "系统设置") {
		t.Fatalf("无可用模型应如实说明并引导 Web 设置页：%q", view)
	}
}

func TestSwitchModelSameModelSkipped(t *testing.T) {
	api := &fakeAPI{}
	sessions := []client.Session{{ID: "s1", Title: "会话", ModelProfileID: "p2", ModelRevision: 2}}
	model := bootReady(t, api, sessions, pickerModels())
	model = step(t, model, key("m"))
	if model.phase != phasePicker || model.picker.mode != pickerSwitch {
		t.Fatalf("m 应进入切换模型向导：phase=%d", model.phase)
	}
	// 无档位模型：同模型不重切，直接回列表提示；声明档位的模型进入档位调整步
	//（见 TestFixSameModelSelectionAdjustsLevelWithoutSwitching）。
	model = step(t, model, keyDown)
	model = step(t, model, keyEnter)
	if model.phase != phaseSessions || !strings.Contains(model.notice, "已在使用该模型") {
		t.Fatalf("同模型不重切：phase=%d notice=%q", model.phase, model.notice)
	}
	if api.switchInput != nil {
		t.Fatal("同模型重切不应发请求")
	}
}

func TestSwitchModelDifferentModelSubmits(t *testing.T) {
	api := &fakeAPI{switched: client.Session{ID: "s1"}}
	sessions := []client.Session{{ID: "s1", Title: "会话", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, pickerModels())
	model.levels["s1"] = "max"
	model = step(t, model, key("m"))
	model = step(t, model, keyDown)
	model = step(t, model, keyEnter)
	if model.phase != phaseSessions || !strings.Contains(model.notice, "模型已切换") {
		t.Fatalf("切换成功应回列表并提示：phase=%d notice=%q", model.phase, model.notice)
	}
	if api.switchInput == nil || api.switchInput.ModelProfileID != "p2" {
		t.Fatalf("应提交 p2 切换：%+v", api.switchInput)
	}
	if model.list.sessions[0].ModelProfileID != "p2" {
		t.Fatalf("列表行应更新模型：%+v", model.list.sessions[0])
	}
}

func TestSessionViewShowsRunFailure(t *testing.T) {
	api := &fakeAPI{
		tasks: []client.Task{{
			ID: "t1", Kind: "agent", CreatedAt: "2026-10-25T08:00:00.000Z",
			LatestRun: &client.Run{ID: "r1", Status: "failed", EndReason: "approval-expired", Error: &client.Failure{Code: "x", Message: "审批已过期，运行终止"}},
		}},
	}
	sessions := []client.Session{{ID: "s1", Title: "失败会话", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	if view := model.View(); !strings.Contains(view, "运行失败") || !strings.Contains(view, "审批已过期，运行终止") {
		t.Fatalf("运行失败态应展示终态与服务端消息：%q", view)
	}
}

func TestSessionViewInterruptedPanelRestartExplained(t *testing.T) {
	api := &fakeAPI{
		tasks: []client.Task{{ID: "t1", Kind: "agent", CreatedAt: "2026-10-25T08:00:00.000Z",
			LatestRun: &client.Run{ID: "r1", Status: "interrupted", EndReason: "panel-restarted"}}},
	}
	sessions := []client.Session{{ID: "s1", Title: "中断", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	if view := model.View(); !strings.Contains(view, "面板重启导致运行中断") {
		t.Fatalf("interrupted(panel-restarted) 应附面板重启说明：%q", view)
	}
}

func TestSessionViewMissingFallsBackToList(t *testing.T) {
	api := &fakeAPI{sessionErr: &client.Error{Kind: client.KindServer, Status: 404, Message: "会话不存在"}}
	sessions := []client.Session{{ID: "gone", Title: "已删", ModelProfileID: "p1", ModelRevision: 1}}
	model := bootReady(t, api, sessions, nil)
	model = step(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "gone"))
	if model.phase != phaseSessions {
		t.Fatalf("会话 404 应回列表：%d", model.phase)
	}
}

func TestBootResumePointerEntersSessionDirectly(t *testing.T) {
	api := &fakeAPI{}
	api.cookie = "stored"
	api.probeAuth = true
	deps := &fakeDeps{api: api, discover: okDiscover, loadState: func() StoredState {
		return StoredState{Selected: "last"}
	}}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	if model.phase != phaseSessions {
		t.Fatalf("boot 应先进列表装配：%d", model.phase)
	}
	if model.selected != "last" {
		t.Fatalf("本地指针应载入：%q", model.selected)
	}
	model = runCmd(t, model, loadChatCmd(api, "last"))
	if model.phase != phaseSession || model.chat.sessionID != "last" {
		t.Fatalf("指针命中应直接进入会话详情（恢复链）：phase=%d", model.phase)
	}
}

func TestCtrlCQuitsFromList(t *testing.T) {
	model := bootReady(t, &fakeAPI{}, nil, nil)
	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("Ctrl+C 应退出程序")
	}
}

func TestEscFromListQuitsTUI(t *testing.T) {
	model := bootReady(t, &fakeAPI{}, nil, nil)
	_, cmd := model.Update(keyEsc)
	if cmd == nil {
		t.Fatal("列表屏 Esc 应退出 TUI 返回主菜单")
	}
}

func TestErrTextJoinsHintAndRetryAfter(t *testing.T) {
	err := &client.Error{Kind: client.KindServer, Status: 429, Message: "登录尝试过于频繁，请稍后再试", RetryAfter: 37}
	if got := errText(err); !strings.Contains(got, "37 秒") {
		t.Fatalf("429 文案应带等待秒数：%q", got)
	}
	if errText(errors.New("普通错误")) != "普通错误" {
		t.Fatal("非 client 错误应回原文")
	}
}

func (f *fakeAPI) ListRuns(context.Context, string, string, string) (client.Page[client.Run], error) {
	return client.Page[client.Run]{}, nil
}
func (f *fakeAPI) ModelRequests(context.Context, string, string) (client.Page[client.ModelRequest], error) {
	return client.Page[client.ModelRequest]{}, nil
}
func (f *fakeAPI) ListSessionTasksPage(ctx context.Context, id, cursor string) (client.Page[client.Task], error) {
	return f.ListSessionTasks(ctx, id, 200)
}
func (f *fakeAPI) UploadImage(context.Context, string, []byte) (client.MessageAttachment, error) {
	return client.MessageAttachment{}, nil
}
func (f *fakeAPI) AttachmentContent(context.Context, string) ([]byte, error) { return nil, nil }
