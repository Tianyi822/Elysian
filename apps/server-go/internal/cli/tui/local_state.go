package tui

import (
	"encoding/json"
	"fmt"

	"elysian/server/internal/cli/client"
	tea "github.com/charmbracelet/bubbletea"
)

// LocalSession 仅保存客户端草稿和精确待确认请求；公开历史仍由服务端提供。
type LocalSession struct {
	EditingActive bool                       `json:"editingActive,omitempty"`
	DraftRevision uint64                     `json:"draftRevision,omitempty"`
	Upload        *UploadState               `json:"upload,omitempty"`
	Revision      uint64                     `json:"revision,omitempty"`
	Draft         string                     `json:"draft,omitempty"`
	Editing       *EditDraft                 `json:"editing,omitempty"`
	Attachments   []client.MessageAttachment `json:"attachments,omitempty"`
	Pending       *StoredPending             `json:"pending,omitempty"`
}

type EditDraft struct {
	AcceptedRunID string                     `json:"acceptedRunId,omitempty"`
	Upload        *UploadState               `json:"upload,omitempty"`
	MessageID     string                     `json:"messageId"`
	TaskID        string                     `json:"taskId"`
	Content       string                     `json:"content"`
	Attachments   []client.MessageAttachment `json:"attachments,omitempty"`
}

type StoredPending struct {
	Operation     string            `json:"operation,omitempty"`
	DraftRevision uint64            `json:"draftRevision,omitempty"`
	SessionID     string            `json:"sessionId"`
	TaskID        string            `json:"taskId,omitempty"`
	Input         client.AgentInput `json:"input"`
}

func (p *pendingSend) request() client.AgentInput {
	if p.input != nil {
		return *p.input
	}
	return client.AgentInput{RequestID: p.requestID, Content: p.content, PermissionMode: p.permissionMode, ReasoningLevel: p.reasoningLevel, AuthorizationMode: p.authorizationMode, ExtensionMode: "enabled"}
}

func pendingFromStored(p *StoredPending) *pendingSend {
	if p == nil {
		return nil
	}
	in := p.Input
	return &pendingSend{requestID: in.RequestID, content: in.Content, permissionMode: in.PermissionMode, reasoningLevel: in.ReasoningLevel, authorizationMode: in.AuthorizationMode, taskID: p.TaskID, draftRevision: p.DraftRevision, input: &in}
}

func (m *Model) captureLocal() {
	if m.chat.sessionID == "" {
		return
	}
	if m.locals == nil {
		m.locals = map[string]LocalSession{}
	}
	s := m.locals[m.chat.sessionID]
	if m.chat.editing != nil {
		e := *m.chat.editing
		e.Content = m.chat.editor.Value()
		s.Editing = &e
		s.EditingActive = true
	} else {
		s.Draft = m.chat.editor.Value()
		s.EditingActive = false
	}
	s.DraftRevision = m.chat.draftRevision
	s.Upload = m.chat.upload
	s.Attachments = append([]client.MessageAttachment(nil), m.chat.attachments...)
	s.Pending = nil
	if p := m.chat.pending; p != nil {
		operation := "create"
		if p.taskID != "" {
			operation = "continue"
		}
		if p.request().ReplaceMessageID != "" {
			operation = "replace"
		}
		s.Pending = &StoredPending{Operation: operation, DraftRevision: m.chat.pending.draftRevision, SessionID: m.chat.sessionID, TaskID: p.taskID, Input: p.request()}
	}
	m.locals[m.chat.sessionID] = s
	// 旧内存接缝仅用于兼容；落盘以 Sessions 为权威。
	m.drafts[m.chat.sessionID] = encodeDraftEntry(s.Draft, m.chat.pending)
}

func cloneState(s StoredState) StoredState {
	b, _ := json.Marshal(s)
	var out StoredState
	_ = json.Unmarshal(b, &out)
	return out
}

type stateSavedMsg struct{ err error }

// 小型本地状态按 UI 顺序保存，避免异步快照乱序覆盖已确认请求。
func (m Model) persist() error {
	if m.deps.SaveState == nil {
		return fmt.Errorf("本地状态存储不可用")
	}
	return m.deps.SaveState(m.storedState())
}

func (m Model) persistNotice() (tea.Model, tea.Cmd) {
	m.captureLocal()
	if err := m.persist(); err != nil {
		m.notice = "保存失败：" + err.Error()
		m.noticeBad = true
	}
	return m, nil
}

func (m *Model) confirmPending(run client.Run) {
	p := m.chat.pending
	if p == nil || run.RequestID != p.requestID || run.SessionID != m.chat.sessionID || (p.taskID != "" && run.TaskID != p.taskID) {
		return
	}
	in := p.request()
	if in.ReplaceMessageID != "" {
		m.captureLocal()
		local := m.locals[m.chat.sessionID]
		if edit := local.Editing; edit != nil && edit.MessageID == in.ReplaceMessageID {
			if edit.Content == in.Content && m.chat.draftRevision == p.draftRevision {
				local.Editing = nil
			} else {
				// 后续输入独立保留，下一次 F2 以已受理轮次的新消息身份继续编辑。
				edit.AcceptedRunID = run.ID
			}
		}
		local.EditingActive = false
		m.locals[m.chat.sessionID] = local
		m.chat.editing = nil
		m.chat.editor.SetValue(local.Draft)
	} else {
		if m.chat.editor.Value() == in.Content && m.chat.draftRevision == p.draftRevision {
			m.chat.editor.SetValue("")
		}
		sent := map[string]bool{}
		for _, a := range in.Attachments {
			sent[a.ID] = true
		}
		kept := m.chat.attachments[:0]
		for _, a := range m.chat.attachments {
			if !sent[a.ID] {
				kept = append(kept, a)
			}
		}
		m.chat.attachments = kept
	}
	m.chat.pending = nil
	m.captureLocal()
	if err := m.persist(); err != nil {
		m.notice = "请求已受理，但本地确认保存失败：" + err.Error()
		m.noticeBad = true
	}
}
