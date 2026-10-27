package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/cli/client"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

func TestTerminalLayoutMatrix(t *testing.T) {
	if os.Getenv("ELYSIAN_CLI_VISUAL_COLOR") == "1" {
		profile := lipgloss.ColorProfile()
		dark := lipgloss.HasDarkBackground()
		lipgloss.SetColorProfile(termenv.ANSI256)
		lipgloss.SetHasDarkBackground(true)
		t.Cleanup(func() { lipgloss.SetColorProfile(profile); lipgloss.SetHasDarkBackground(dark) })
	} else {
		t.Setenv("NO_COLOR", "1")
	}
	for _, size := range [][2]int{{100, 32}, {80, 24}, {60, 12}, {35, 8}} {
		for _, screen := range []string{"login", "sessions", "picker", "chat", "help"} {
			t.Run(fmt.Sprintf("%s-%dx%d", screen, size[0], size[1]), func(t *testing.T) {
				m := New((&fakeDeps{api: &fakeAPI{}, discover: okDiscover}).deps())
				defer m.life.cancel()
				m.baseURL = "http://127.0.0.1:48101"
				m.login = newLoginState()
				m.list = newListState()
				m.list.loading = false
				m.list.models = pickerModels()
				for i := 0; i < 35; i++ {
					m.list.sessions = append(m.list.sessions, client.Session{ID: fmt.Sprint(i), Title: "事故排查 · 中文 é 👨‍👩‍👧‍👦", ModelProfileID: "p1"})
				}
				m.list.cursor = 17
				switch screen {
				case "login":
					m.phase = phaseLogin
				case "sessions":
					m.phase = phaseSessions
				case "picker":
					m.phase = phasePicker
					m.picker = newPickerState(pickerSwitch, pickerModels(), "")
				case "chat":
					m.phase = phaseSession
					m.chat = newChatState("s1")
					m.chat.loading = false
					m.chat.session = &client.Session{ID: "s1", Title: "服务器诊断", ModelProfileID: "p1"}
					m.chat.messages = []client.Message{{Role: "user", Content: "检查服务器状态"}, {Role: "assistant", Content: "已读取采样。\n\n```sh\nsystemctl status elysian\n```\n" + strings.Repeat("中文 é 测试 ", 12)}}
				case "help":
					m.help = true
				}
				next, _ := m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
				m = next.(Model)
				view := m.View()
				for _, line := range strings.Split(view, "\n") {
					if ansi.StringWidth(line) > size[0] {
						t.Fatalf("行宽超限 %d>%d：%q", ansi.StringWidth(line), size[0], line)
					}
				}
				if size[0] >= 60 && lipgloss.Height(strings.TrimRight(view, "\n")) > size[1] {
					t.Fatalf("高度超限 %d>%d：\n%s", lipgloss.Height(strings.TrimRight(view, "\n")), size[1], view)
				}
				if size[0] >= 60 && screen == "chat" && !strings.Contains(view, "Enter 发送") {
					t.Fatal("输入操作被挤出可视区")
				}
				if dir := os.Getenv("ELYSIAN_CLI_VISUAL_DIR"); dir != "" {
					if err := os.MkdirAll(dir, 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s-%dx%d.txt", screen, size[0], size[1])), []byte(view), 0600); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	}
}

func TestAuthenticationOnlyDoesNotReadAgentState(t *testing.T) {
	d := (&fakeDeps{api: &fakeAPI{}, discover: okDiscover}).deps()
	d.LoadStateChecked = func() (StoredState, error) {
		t.Fatal("更新登录不能读取聊天状态")
		return StoredState{}, nil
	}
	m := New(d)
	defer m.life.cancel()
	m.authOnly = true
	next, cmd := m.updateBoot(bootMsg{baseURL: "http://127.0.0.1:48101", api: &fakeAPI{cookie: "valid"}})
	if !next.(Model).authReady || cmd == nil {
		t.Fatal("独立登录未完成")
	}
}
