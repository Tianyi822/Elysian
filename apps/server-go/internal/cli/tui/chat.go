package tui

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"elysian/server/internal/cli/client"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

// 聊天屏进入时分页回读公开历史，活跃 Run 接续 SSE 与可取消的轮询。
// 发送先持久化完整请求，人工重试保留同一 requestId 和载荷；受理以精确 Run 回读确认。
// 历史、工具结果、审批、运行时授权、澄清输入与图片都消费同一 Harness 的正式 API。

// chatPollInterval 活跃 Run 的轮询间隔（兜底流断连时的状态推进）。
const chatPollInterval = 2 * time.Second

// chatEditorHeight 输入区行数。
const chatEditorHeight = 3

// pendingSend 未确认提交：requestId、精确输入与首次提交时参与服务端幂等校验的
// 全部字段（权限模式、思考档、运行时授权开关、续轮目标 taskID 与提交时的消息游标；
// 失败重试与重进会话后的重试都复用同 id 同载荷，与服务端幂等键同生命周期；重试期间
// 本地切换权限模式／思考档不改写已冻结的提交载荷，与 Web dispatchPending 同口径）。
type pendingSend struct {
	draftRevision     uint64
	input             *client.AgentInput
	requestID         string
	content           string
	permissionMode    string
	reasoningLevel    string
	authorizationMode string
	taskID            string // 首次提交的续轮目标（空表示首轮走 CreateTask）
	afterSeq          string // 首次提交时已知的最新消息 seq（重进会话核对受理事实的游标）
}

// storedPending pendingSend 的持久化形状（drafts 信封内）。
type storedPending struct {
	RequestID         string `json:"requestId"`
	Content           string `json:"content"`
	PermissionMode    string `json:"permissionMode,omitempty"`
	ReasoningLevel    string `json:"reasoningLevel,omitempty"`
	AuthorizationMode string `json:"authorizationMode,omitempty"`
	TaskID            string `json:"taskId,omitempty"`
	AfterSeq          string `json:"afterSeq,omitempty"`
}

// draftEnvelope 每会话草稿信封：与草稿同一条持久化路径（StoredState.Drafts →
// ~/.elysian/cli/state.json 的 drafts 项），把输入草稿与未确认提交一起随值保存；
// Marker 恒 "1"，用于区分信封与纯文本草稿（旧格式回读按草稿原文处理）。
type draftEnvelope struct {
	Marker  string         `json:"elysianDraft"`
	Draft   string         `json:"draft"`
	Pending *storedPending `json:"pending,omitempty"`
}

// encodeDraftEntry 写入 drafts map 的值：有未确认提交时编码信封，否则保持纯文本
// 草稿（与旧格式兼容）。
func encodeDraftEntry(draft string, pending *pendingSend) string {
	if pending == nil {
		return draft
	}
	stored := &storedPending{
		RequestID:         pending.requestID,
		Content:           pending.content,
		PermissionMode:    pending.permissionMode,
		ReasoningLevel:    pending.reasoningLevel,
		AuthorizationMode: pending.authorizationMode,
		TaskID:            pending.taskID,
		AfterSeq:          pending.afterSeq,
	}
	raw, err := json.Marshal(draftEnvelope{Marker: "1", Draft: draft, Pending: stored})
	if err != nil {
		// 纯字符串字段编码不可能失败；防御性回退纯草稿。
		return draft
	}
	return string(raw)
}

// decodeDraftEntry 回读 drafts map 的值：带标记的信封解析出草稿与未确认提交，
// 其余（纯文本草稿或损坏信封）按草稿原文处理。
func decodeDraftEntry(raw string) (string, *pendingSend) {
	var envelope draftEnvelope
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil || envelope.Marker != "1" {
		return raw, nil
	}
	if envelope.Pending == nil || envelope.Pending.RequestID == "" || envelope.Pending.Content == "" {
		return envelope.Draft, nil
	}
	pending := &pendingSend{
		requestID:         envelope.Pending.RequestID,
		content:           envelope.Pending.Content,
		permissionMode:    envelope.Pending.PermissionMode,
		reasoningLevel:    envelope.Pending.ReasoningLevel,
		authorizationMode: envelope.Pending.AuthorizationMode,
		taskID:            envelope.Pending.TaskID,
		afterSeq:          envelope.Pending.AfterSeq,
	}
	return envelope.Draft, pending
}

// chatState 聊天屏状态。
type chatState struct {
	wizardDismissed bool
	draftRevision   uint64
	upload          *UploadState
	editing         *EditDraft
	attachments     []client.MessageAttachment
	history         *historyPanel
	attachmentPanel *attachmentPanel
	sessionID       string
	session         *client.Session
	taskID          string // 续轮目标（会话最新 agent 任务；空则首轮走 CreateTask）

	messages []client.Message
	lastSeq  string
	loading  bool
	loadErr  string

	runID     string
	runStatus string
	lastRun   *client.Run          // 最近 Run（终态归因行渲染材料）
	stream    *client.ChatOutput   // 最新流快照（含 timeline；终态后保留至离开）
	timeline  *client.ChatTimeline // 最近运行过程快照（流帧或轮询；上下文用量数据源）

	sending  bool
	pending  *pendingSend
	stopping bool

	polling       bool // 轮询在途（防重入）
	streamHealthy bool // 流连接健康（断连时状态行如实提示）
	showReasoning bool // 思考全文展开（默认折叠摘要）

	plan             *client.RunPlan   // 计划快照（timeline.Plan）
	showPlan         bool              // 计划步骤展开
	wizard           *inputWizard      // 等待用户输入向导（waiting-input 接管输入区）
	panel            *approvalPanel    // 审批面板覆盖层（Ctrl+A）
	tools            *toolDetail       // 工具过程详情覆盖层（Ctrl+O）
	pendingApprovals []client.Approval // 最新审批轮询的展示集（徽标与面板预热）
	approvalPolling  bool              // 待审批期轮询在途

	editor   textarea.Model
	viewport viewport.Model
	follow   bool // 消息区跟随底部
}

func newChatState(sessionID string) chatState {
	editor := textarea.New()
	editor.ShowLineNumbers = false
	editor.SetHeight(chatEditorHeight)
	editor.SetWidth(64)
	editor.Placeholder = "输入消息，Enter 发送，Ctrl+J 换行"
	vp := viewport.New(64, 10)
	return chatState{sessionID: sessionID, loading: true, follow: true, editor: editor, viewport: vp}
}

// —— 异步消息 ——

// chatLoadedMsg 进入聊天屏的全量装配回填。
type chatLoadedMsg struct {
	sessionID string
	session   *client.Session
	taskID    string
	latestRun *client.Run
	// timeline 是最新 Run 已终态时按需回读的过程快照（活跃 Run 由 SSE 流携带），
	// 供重入会话后 Ctrl+O 查看工具执行与思考过程。
	timeline *client.ChatTimeline
	messages []client.Message
	lastSeq  string
	err      error
}

// streamFrameMsg 流订阅帧（全量快照）。
type streamFrameMsg struct{ frame client.ChatOutput }

// streamDeadMsg 流订阅致命错误（401 收敛登录）。
type streamDeadMsg struct{ err error }

// streamInterruptedMsg 流连接断开（订阅仍在 1 秒重连循环内）。
type streamInterruptedMsg struct{}

// streamEndedMsg 流订阅 goroutine 结束（退订或 done 收敛）。
type streamEndedMsg struct{}

// submitMsg 提交回填（sessionID 绑定发起会话、requestID 必须匹配原 pending）。
type submitMsg struct {
	sessionID string
	run       client.Run
	requestID string
	err       error
}

// pollMsg 轮询回填（sessionID 与 runID 绑定发起时的归属，迟到即丢弃）。
type pollMsg struct {
	sessionID string
	runID     string
	run       *client.Run
	session   *client.Session
	timeline  *client.ChatTimeline
	err       error
}

// cancelMsg 停止回填（runID 绑定发起停止的运行）。
type cancelMsg struct {
	runID string
	run   client.Run
	err   error
}

// messagesAppendedMsg 增量消息回填（终态后补最终公开消息）。
type messagesAppendedMsg struct {
	sessionID string
	messages  []client.Message
	lastSeq   string
	err       error
}

// errStreamUnsubscribed 订阅退订哨兵（回调内返回以中断读取）。
var errStreamUnsubscribed = errors.New("输出流订阅已退订")

// streamEvent 订阅事件：帧（全量快照）、断连（正在重连）、致命（401 收敛登录）。
type streamEvent struct {
	frame       *client.ChatOutput
	interrupted bool
	fatal       *client.Error
}

// streamSub 流订阅：goroutine 内维护连接与 1 秒重连，事件进 buffered channel；
// TUI 经命令逐事件拉取。stop 关闭后 goroutine 收敛；done 帧后自然结束。cancel 指向
// 当前进度中 HTTP 请求的 context（无在途请求时为 nil）：close 同步取消，退订不必等
// 下一帧或连接预算到期。
type streamSub struct {
	runID  string
	events chan streamEvent
	stop   chan struct{}
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (s *streamSub) close() {
	s.mu.Lock()
	select {
	case <-s.stop:
		s.mu.Unlock()
		return
	default:
	}
	close(s.stop)
	cancel := s.cancel
	s.cancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *streamSub) emit(event streamEvent) bool {
	select {
	case s.events <- event:
		return true
	case <-s.stop:
		return false
	}
}

// openStream 启动订阅 goroutine：连接→帧→断开（发 interrupted）→1 秒重连；401 发
// fatal 并结束；退订或 done 帧后收敛。
func openStream(api API, runID string) *streamSub {
	sub := &streamSub{runID: runID, events: make(chan streamEvent, 32), stop: make(chan struct{})}
	go func() {
		defer close(sub.events)
		stopCancel := context.AfterFunc(apiContext(api), sub.close)
		defer stopCancel()
		for {
			ctx, cancel := context.WithCancel(apiContext(api))
			sub.mu.Lock()
			select {
			case <-sub.stop:
				sub.mu.Unlock()
				cancel()
				return
			default:
			}
			sub.cancel = cancel
			sub.mu.Unlock()
			var sawDone bool
			err := api.StreamChatOutput(ctx, runID, func(frame client.ChatOutput) error {
				copied := frame
				sawDone = frame.Done
				if !sub.emit(streamEvent{frame: &copied}) {
					return errStreamUnsubscribed
				}
				return nil
			})
			sub.mu.Lock()
			sub.cancel = nil
			sub.mu.Unlock()
			cancel()
			if errors.Is(err, errStreamUnsubscribed) || sawDone {
				return
			}
			if err != nil {
				var connErr *client.Error
				if errors.As(err, &connErr) && connErr.Kind == client.KindUnauthorized {
					sub.emit(streamEvent{fatal: connErr})
					return
				}
			}
			// 本连接结束（服务端 30 秒断开／预算到期／网络中断）：如实上报断连并
			// 1 秒后重连，重连帧即最新快照。
			if !sub.emit(streamEvent{interrupted: true}) {
				return
			}
			select {
			case <-sub.stop:
				return
			case <-time.After(time.Second):
			}
		}
	}()
	return sub
}

// streamListenCmd 从订阅拉取下一个事件（帧／断连／致命／订阅结束）。
func streamListenCmd(sub *streamSub) tea.Cmd {
	return func() tea.Msg {
		select {
		case event, ok := <-sub.events:
			if !ok {
				return streamEndedMsg{}
			}
			switch {
			case event.fatal != nil:
				return streamDeadMsg{err: event.fatal}
			case event.frame != nil:
				return streamFrameMsg{frame: *event.frame}
			default:
				return streamInterruptedMsg{}
			}
		case <-sub.stop:
			return streamEndedMsg{}
		}
	}
}

// loadChatCmd 全量装配：会话＋最新 agent 任务（taskID 与 latestRun）＋消息升序
// 分页续拉到头。
func loadChatCmd(api API, sessionID string) tea.Cmd {
	return func() tea.Msg {
		session, err := api.GetSession(apiContext(api), sessionID)
		if err != nil {
			return chatLoadedMsg{sessionID: sessionID, err: err}
		}
		taskID, latestRun := "", (*client.Run)(nil)
		cursor := ""
		for {
			page, taskErr := api.ListSessionTasksPage(apiContext(api), sessionID, cursor)
			if taskErr != nil {
				return chatLoadedMsg{sessionID: sessionID, err: taskErr}
			}
			taskID, latestRun = latestAgentTask(page.Items)
			if taskID != "" || !page.HasMore {
				break
			}
			if page.NextCursor == "" || page.NextCursor == cursor {
				return chatLoadedMsg{sessionID: sessionID, err: errors.New("任务分页游标无效")}
			}
			cursor = page.NextCursor
		}
		messages, lastSeq, err := loadAllMessages(api, sessionID)
		if err != nil {
			return chatLoadedMsg{sessionID: sessionID, session: &session, taskID: taskID, latestRun: latestRun, err: err}
		}
		msg := chatLoadedMsg{sessionID: sessionID, session: &session, taskID: taskID, latestRun: latestRun, messages: messages, lastSeq: lastSeq}
		if latestRun != nil && terminalRun(latestRun.Status) {
			// 已完成 Run 的过程记录按需回读：重入会话后工具执行与思考仍可查看。
			if snap, snapErr := api.TimelineSnapshot(apiContext(api), latestRun.ID); snapErr == nil {
				msg.timeline = &snap
			} else {
				return chatLoadedMsg{sessionID: sessionID, err: snapErr}
			}
		}
		return msg
	}
}

// latestAgentTask 取创建序内最新的 agent 任务与其 latestRun。
func latestAgentTask(tasks []client.Task) (string, *client.Run) {
	var best *client.Task
	for i := range tasks {
		task := &tasks[i]
		if task.Kind != "agent" {
			continue
		}
		if best == nil || task.CreatedAt > best.CreatedAt {
			best = task
		}
	}
	if best == nil {
		return "", nil
	}
	return best.ID, best.LatestRun
}

// loadAllMessages 消息升序分页续拉到头（每页 100 条；最多 200 页防御异常 hasMore）。
func loadAllMessages(api API, sessionID string) ([]client.Message, string, error) {
	var all []client.Message
	after := ""
	for i := 0; i < 200; i++ {
		page, err := api.ListMessages(apiContext(api), sessionID, after)
		if err != nil {
			return nil, "", err
		}
		all = append(all, page.Items...)
		if !page.HasMore || page.NextCursor == "" {
			if len(page.Items) > 0 {
				return all, page.Items[len(page.Items)-1].Seq, nil
			}
			return all, lastNonEmptySeq(all), nil
		}
		after = page.NextCursor
	}
	return all, lastNonEmptySeq(all), nil
}

func lastNonEmptySeq(messages []client.Message) string {
	if len(messages) == 0 {
		return ""
	}
	return messages[len(messages)-1].Seq
}

// appendMessagesCmd 增量回读（after=lastSeq）。
func appendMessagesCmd(api API, sessionID, after string) tea.Cmd {
	return func() tea.Msg {
		page, err := api.ListMessages(apiContext(api), sessionID, after)
		if err != nil {
			return messagesAppendedMsg{sessionID: sessionID, err: err}
		}
		return messagesAppendedMsg{sessionID: sessionID, messages: page.Items, lastSeq: lastNonEmptySeq(page.Items)}
	}
}

// submitCmd 提交（taskID 空走创建任务，否则续轮）；回填绑定会话与 requestId。
func submitCmd(api API, sessionID, taskID string, input client.AgentInput) tea.Cmd {
	return func() tea.Msg {
		var run client.Run
		var err error
		if taskID == "" {
			run, err = api.CreateTask(apiContext(api), sessionID, input)
		} else {
			run, err = api.ContinueTask(apiContext(api), taskID, input)
		}
		return submitMsg{sessionID: sessionID, run: run, requestID: input.RequestID, err: err}
	}
}

// pollRunCmd 轮询（延时后拉 run 与 timeline，兜底流断连时的状态推进）；回填绑定
// 会话与运行，迟到回填由 Update 丢弃。
func pollRunCmd(api API, sessionID, runID string, delay time.Duration) tea.Cmd {
	return func() tea.Msg {
		if !waitContext(apiContext(api), delay) {
			return nil
		}
		msg := pollMsg{sessionID: sessionID, runID: runID}
		if run, err := api.GetRun(apiContext(api), runID); err == nil {
			msg.run = &run
		} else {
			msg.err = err
		}
		if timeline, err := api.TimelineSnapshot(apiContext(api), runID); err == nil {
			msg.timeline = &timeline
		}
		if session, err := api.GetSession(apiContext(api), sessionID); err == nil {
			msg.session = &session
		}
		return msg
	}
}

// cancelRunCmd 停止回复；回填绑定发起停止的运行。
func cancelRunCmd(api API, runID string) tea.Cmd {
	return func() tea.Msg {
		run, err := api.CancelRun(apiContext(api), runID)
		return cancelMsg{runID: runID, run: run, err: err}
	}
}

// terminalRun 终态判定（与服务端 terminal() 同集）。
func terminalRun(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled", "interrupted", "recovery-required":
		return true
	}
	return false
}

// activeRun 会话当前可继续消费的 run（活跃或等待态）。
func activeRun(status string) bool {
	switch status {
	case "queued", "running", "waiting-input", "waiting-approval", "waiting-resource", "waiting-task", "preparing-runtime":
		return true
	}
	return false
}

type publicReloadMsg struct {
	sessionID string
	messages  []client.Message
	seq       string
	err       error
}

func reloadPublicCmd(api API, sessionID string) tea.Cmd {
	return func() tea.Msg {
		messages, seq, err := loadAllMessages(api, sessionID)
		return publicReloadMsg{sessionID, messages, seq, err}
	}
}
