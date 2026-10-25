package tui

import tea "github.com/charmbracelet/bubbletea"

// Bubbles 的粘贴、光标与焦点等非按键消息同样必须回到当前组件。
func (m Model) updateComponents(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.help {
		return m, nil
	}
	var editor *lineEditor
	switch m.phase {
	case phaseLogin:
		if !m.login.busy {
			editor = m.login.user
			if m.login.field == loginFieldPassword {
				editor = m.login.password
			}
		}
	case phasePicker:
		if m.picker.step == stepTitle && !m.picker.busy {
			editor = m.picker.title
		}
	case phaseSessions:
		if !m.list.busy {
			editor = m.list.rename
		}
	case phaseSession:
		if m.help {
			return m, nil
		}
		if p := m.chat.attachmentPanel; p != nil {
			var cmd tea.Cmd
			if p.browse {
				p.picker, cmd = p.picker.Update(msg)
			} else if p.typing {
				p.path, cmd = p.path.Update(msg)
			}
			return m, cmd
		}
		if h := m.chat.history; h != nil {
			var cmd tea.Cmd
			if h.detail {
				h.viewport, cmd = h.viewport.Update(msg)
			} else {
				h.list, cmd = h.list.Update(msg)
			}
			return m, cmd
		}
		if w := m.chat.wizard; w != nil {
			if w.textMode && !w.submitting {
				editor = w.textEditor
			}
		} else if m.chat.panel == nil && m.chat.tools == nil {
			var cmd tea.Cmd
			m.chat.editor, cmd = m.chat.editor.Update(msg)
			return m, cmd
		}
	}
	if editor != nil {
		return m, editor.update(msg)
	}
	return m, nil
}
