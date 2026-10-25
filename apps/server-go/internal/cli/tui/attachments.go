package tui

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"elysian/server/internal/cli/client"
	"github.com/charmbracelet/bubbles/filepicker"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type UploadState struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}
type attachmentPanel struct {
	viewport             viewport.Model
	generation           uint64
	picker               filepicker.Model
	path                 textinput.Model
	browse, typing, busy bool
	index                int
	err, exported        string
	cancel               context.CancelFunc
}
type attachmentDoneMsg struct {
	attachment client.MessageAttachment
	path       string
	prepared   []byte
	name       string
	err        error
	exported   string
}

func (m *Model) draftAttachments() *[]client.MessageAttachment {
	if m.chat.editing != nil {
		return &m.chat.editing.Attachments
	}
	return &m.chat.attachments
}
func (m *Model) uploadState() **UploadState {
	if m.chat.editing != nil {
		return &m.chat.editing.Upload
	}
	return &m.chat.upload
}
func (m Model) openAttachments() (tea.Model, tea.Cmd) {
	p := filepicker.New()
	p.AllowedTypes = []string{".png", ".jpg", ".jpeg"}
	p.CurrentDirectory, _ = os.Getwd()
	p.Height = max(4, m.height-8)
	input := textinput.New()
	input.Placeholder = "输入图片绝对路径"
	input.Width = max(20, m.width-4)
	m.chat.attachmentPanel = &attachmentPanel{picker: p, path: input, viewport: viewport.New(max(20, m.width-2), max(4, m.height-9))}
	return m, nil
}
func (m Model) attachmentItems() []client.MessageAttachment {
	a := append([]client.MessageAttachment(nil), m.chat.attachments...)
	if m.chat.editing != nil {
		a = append([]client.MessageAttachment(nil), m.chat.editing.Attachments...)
	}
	for _, msg := range m.chat.messages {
		a = append(a, msg.Attachments...)
	}
	return a
}
func (m Model) updateAttachmentKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	p := m.chat.attachmentPanel
	if key.String() == "esc" {
		if p.busy && p.cancel != nil {
			p.cancel()
			p.generation++
			p.busy = false
			p.err = "操作已取消；上传若已派发则结果未知，可移除本地状态后手动重试"
			return m, nil
		}
		if p.browse || p.typing {
			p.browse = false
			p.typing = false
			return m, nil
		}
		m.chat.attachmentPanel = nil
		return m, saveStateCmd(m)
	}
	if p.busy {
		return m, nil
	}
	if p.typing {
		if key.String() == "enter" {
			p.typing = false
			return m.startImageUpload(p.path.Value())
		}
		var cmd tea.Cmd
		p.path, cmd = p.path.Update(key)
		return m, cmd
	}
	if p.browse {
		var cmd tea.Cmd
		p.picker, cmd = p.picker.Update(key)
		if yes, path := p.picker.DidSelectFile(key); yes {
			p.browse = false
			return m.startImageUpload(path)
		}
		return m, cmd
	}
	items := m.attachmentItems()
	switch key.String() {
	case "a":
		p.browse = true
		return m, p.picker.Init()
	case "p":
		p.typing = true
		return m, p.path.Focus()
	case "up":
		if p.index > 0 {
			p.index--
		}
	case "down":
		if p.index+1 < len(items) {
			p.index++
		}
	case "d":
		if m.chat.pending != nil {
			p.err = "提交未确认时不能移除附件"
			return m, nil
		}
		a := m.draftAttachments()
		if *m.uploadState() != nil {
			*m.uploadState() = nil
		} else if p.index < len(*a) {
			*a = append((*a)[:p.index], (*a)[p.index+1:]...)
		} else {
			p.err = "已发送附件属于历史，不能从草稿删除"
		}
		return m, saveStateCmd(m)
	case "e", "o":
		if p.index >= len(items) {
			return m, nil
		}
		a := items[p.index]
		p.generation++
		p.busy = true
		ctx, cancel := context.WithCancel(apiContext(m.chatAPI()))
		p.cancel = cancel
		api := m.chatAPI()
		open := key.String() == "o"
		return m, func() tea.Msg {
			defer cancel()
			raw, err := api.AttachmentContent(ctx, a.ID)
			if err != nil {
				return attachmentDoneMsg{err: err}
			}
			dir, err := os.MkdirTemp("", "ely-image-")
			if err != nil {
				return attachmentDoneMsg{err: err}
			}
			path := filepath.Join(dir, filepath.Base(a.Name))
			if filepath.Base(a.Name) == "." || filepath.Base(a.Name) == "/" {
				path = filepath.Join(dir, "image")
			}
			if err = os.WriteFile(path, raw, 0600); err == nil && open {
				err = openImage(ctx, path)
			}
			return attachmentDoneMsg{exported: path, err: err}
		}
	}
	return m, nil
}
func (m Model) startImageUpload(path string) (tea.Model, tea.Cmd) {
	p := m.chat.attachmentPanel
	if m.chat.pending != nil || m.chat.sending {
		p.err = "提交未确认时不能添加附件"
		return m, nil
	}
	if *m.uploadState() != nil {
		p.err = "上次图片处理或上传未确认；按 d 清除本地状态后再手动添加"
		return m, nil
	}
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, path[2:])
		}
	}
	*m.uploadState() = &UploadState{Path: path, Status: "preparing"}
	m.captureLocal()
	if err := m.persist(); err != nil {
		p.err = errText(err)
		return m, nil
	}
	p.generation++
	p.busy = true
	p.err = ""
	ctx, cancel := context.WithCancel(apiContext(m.chatAPI()))
	p.cancel = cancel
	return m, func() tea.Msg {
		defer cancel()
		name, raw, err := client.PrepareImage(ctx, path)
		return attachmentDoneMsg{path: path, name: name, prepared: raw, err: err}
	}
}
func (m Model) updateAttachmentDone(msg attachmentDoneMsg) (tea.Model, tea.Cmd) {
	p := m.chat.attachmentPanel
	if p == nil {
		return m, nil
	}
	p.busy = false
	if msg.exported != "" {
		p.exported = msg.exported
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		p.err = errText(msg.err)
		return m, nil
	}
	if msg.prepared != nil {
		total := len(msg.prepared)
		for _, a := range *m.draftAttachments() {
			total += a.Bytes
		}
		if total > client.ImageMessageLimit {
			p.err = "每条消息的图片合计不能超过 8 MiB"
			*m.uploadState() = nil
			return m, saveStateCmd(m)
		}
		*m.uploadState() = &UploadState{Path: msg.path, Status: "unknown"}
		m.captureLocal()
		if err := m.persist(); err != nil {
			p.err = errText(err)
			return m, nil
		}
		p.busy = true
		ctx, cancel := context.WithCancel(apiContext(m.chatAPI()))
		p.cancel = cancel
		api := m.chatAPI()
		return m, func() tea.Msg {
			defer cancel()
			a, err := api.UploadImage(ctx, msg.name, msg.prepared)
			return attachmentDoneMsg{attachment: a, err: err}
		}
	}
	if msg.attachment.ID != "" {
		a := m.draftAttachments()
		*a = append(*a, msg.attachment)
		*m.uploadState() = nil
		return m, saveStateCmd(m)
	}
	return m, nil
}
func (m Model) attachmentView() string {
	p := m.chat.attachmentPanel
	if p.browse {
		return safeText(p.picker.View()) + "\nEnter 选择 · Esc 返回"
	}
	if p.typing {
		return p.path.View() + "\nEnter 添加 · Esc 返回"
	}
	var b strings.Builder
	b.WriteString("图片附件（JPEG/PNG，单张 1 MiB，合计 8 MiB）\n")
	drafts := len(*m.draftAttachments())
	for i, a := range m.attachmentItems() {
		mark := "  "
		if i == p.index {
			mark = "› "
		}
		status := "草稿 · 已上传"
		if i >= drafts {
			status = "已发送"
		}
		fmt.Fprintf(&b, "%s%s · %d×%d · %d 字节 · %s\n", mark, safeText(a.Name), a.Width, a.Height, a.Bytes, status)
	}
	p.viewport.Width = max(20, m.width-2)
	p.viewport.Height = max(4, m.height-9)
	p.viewport.SetContent(wrapPlain(b.String(), p.viewport.Width))
	p.viewport.SetYOffset(max(0, p.index-p.viewport.Height+2))
	b.Reset()
	b.WriteString(p.viewport.View() + "\n")
	if upload := *m.uploadState(); upload != nil {
		fmt.Fprintf(&b, "未确认：%s · %s（不自动重传）\n", safeText(upload.Path), upload.Status)
	}
	if p.busy {
		b.WriteString("处理中… Esc 取消\n")
	}
	if p.err != "" {
		b.WriteString(safeText(p.err) + "\n")
	}
	if p.exported != "" {
		b.WriteString("已导出：" + safeText(p.exported) + "\n")
	}
	b.WriteString("a 文件选择 · p 输入路径 · ↑↓ 选择 · d 移除草稿/未确认项\ne 导出 · o 导出并外部打开 · Esc 返回")
	return b.String()
}
func openImage(ctx context.Context, path string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	} else if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return fmt.Errorf("无图形环境，请使用上方导出路径")
	}
	return exec.CommandContext(ctx, command, path).Run()
}
