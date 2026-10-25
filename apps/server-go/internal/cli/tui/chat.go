package tui

import (
	"context"
	"errors"
	"time"

	"elysian/server/internal/cli/client"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

// 聊天屏（CLI 方案 §6.2／§6.3 第二步）：进入时全量回读公开历史（messages 按 seq
// 升序分页续拉）、有活跃 Run 时自动接续输出流（SSE 全量快照覆盖渲染）与 2 秒轮询
// 兜底；底部多行输入 Enter 发送／Ctrl+J 换行；发送以 requestId 幂等（失败重试复用
// 同 id 同输入）；停止走 POST /runs/{id}/cancel，取消请求与执行停止分开展示；流断
// 开由订阅内部按 1 秒重连，状态行如实提示。工具过程（timeline tool 条目）以
// 「名称＋状态＋参数摘要」行呈现，结果明细仍按服务端快照（本步不做 calls 分页
// 展开）。等待审批／等待输入等等待态只呈现状态，交互界面属后续版本。

// chatPollInterval 活跃 Run 的轮询间隔（兜底流断连时的状态推进）。
const chatPollInterval = 2 * time.Second

// chatEditorHeight 输入区行数。
const chatEditorHeight = 3

// pendingSend 未确认提交：requestId、精确输入与首次提交时的权限模式（失败重试
// 复用同 id 同输入同模式，与服务端幂等键同生命周期；重试期间切换权限模式不改写
// 已冻结的提交载荷，与 Web dispatchPending 同口径）。
type pendingSend struct {
	requestID      string
	content        string
	permissionMode string
}

// chatState 聊天屏状态。
type chatState struct {
	sessionID string
	session   *client.Session
	taskID    string // 续轮目标（会话最新 agent 任务；空则首轮走 CreateTask）

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
	messages  []client.Message
	lastSeq   string
	err       error
}

// streamFrameMsg 流订阅帧（全量快照）。
type streamFrameMsg struct{ frame client.ChatOutput }

// streamDeadMsg 流订阅致命错误（401 收敛登录）。
type streamDeadMsg struct{ err error }

// streamInterruptedMsg 流连接断开（订阅仍在 1 秒重连循环内）。
type streamInterruptedMsg struct{}

// streamEndedMsg 流订阅 goroutine 结束（退订或 done 收敛）。
type streamEndedMsg struct{}

// submitMsg 提交回填（duplicate 标识幂等重复回执）。
type submitMsg struct {
	run       client.Run
	requestID string
	err       error
}

// pollMsg 轮询回填。
type pollMsg struct {
	run      *client.Run
	session  *client.Session
	timeline *client.ChatTimeline
	err      error
}

// cancelMsg 停止回填。
type cancelMsg struct {
	run client.Run
	err error
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
// TUI 经命令逐事件拉取。stop 关闭后 goroutine 收敛；done 帧后自然结束。
type streamSub struct {
	runID  string
	events chan streamEvent
	stop   chan struct{}
}

func (s *streamSub) close() {
	select {
	case <-s.stop:
	default:
		close(s.stop)
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
		for {
			ctx, cancel := context.WithCancel(context.Background())
			var sawDone bool
			err := api.StreamChatOutput(ctx, runID, func(frame client.ChatOutput) error {
				copied := frame
				sawDone = frame.Done
				if !sub.emit(streamEvent{frame: &copied}) {
					return errStreamUnsubscribed
				}
				return nil
			})
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
		case event := <-sub.events:
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
		session, err := api.GetSession(context.Background(), sessionID)
		if err != nil {
			return chatLoadedMsg{sessionID: sessionID, err: err}
		}
		taskID, latestRun := "", (*client.Run)(nil)
		if page, err := api.ListSessionTasks(context.Background(), sessionID, 200); err == nil {
			taskID, latestRun = latestAgentTask(page.Items)
		}
		messages, lastSeq, err := loadAllMessages(api, sessionID)
		if err != nil {
			return chatLoadedMsg{sessionID: sessionID, session: &session, taskID: taskID, latestRun: latestRun, err: err}
		}
		return chatLoadedMsg{sessionID: sessionID, session: &session, taskID: taskID, latestRun: latestRun, messages: messages, lastSeq: lastSeq}
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
		page, err := api.ListMessages(context.Background(), sessionID, after)
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
		page, err := api.ListMessages(context.Background(), sessionID, after)
		if err != nil {
			return messagesAppendedMsg{sessionID: sessionID, err: err}
		}
		return messagesAppendedMsg{sessionID: sessionID, messages: page.Items, lastSeq: lastNonEmptySeq(page.Items)}
	}
}

// submitCmd 提交（taskID 空走创建任务，否则续轮）。
func submitCmd(api API, sessionID, taskID string, input client.AgentInput) tea.Cmd {
	return func() tea.Msg {
		var run client.Run
		var err error
		if taskID == "" {
			run, err = api.CreateTask(context.Background(), sessionID, input)
		} else {
			run, err = api.ContinueTask(context.Background(), taskID, input)
		}
		return submitMsg{run: run, requestID: input.RequestID, err: err}
	}
}

// pollRunCmd 轮询（延时后拉 run 与 timeline，兜底流断连时的状态推进）。
func pollRunCmd(api API, sessionID, runID string, delay time.Duration) tea.Cmd {
	return func() tea.Msg {
		time.Sleep(delay)
		msg := pollMsg{}
		if run, err := api.GetRun(context.Background(), runID); err == nil {
			msg.run = &run
		} else {
			msg.err = err
		}
		if timeline, err := api.TimelineSnapshot(context.Background(), runID); err == nil {
			msg.timeline = &timeline
		}
		if session, err := api.GetSession(context.Background(), sessionID); err == nil {
			msg.session = &session
		}
		return msg
	}
}

// cancelRunCmd 停止回复。
func cancelRunCmd(api API, runID string) tea.Cmd {
	return func() tea.Msg {
		run, err := api.CancelRun(context.Background(), runID)
		return cancelMsg{run: run, err: err}
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
	case "queued", "running", "waiting-input", "waiting-approval", "waiting-resource", "waiting-task":
		return true
	}
	return false
}
