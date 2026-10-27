package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"
)

func TestUpgradeTerminalLayoutMatrix(t *testing.T) {
	if os.Getenv("ELYSIAN_CLI_VISUAL_COLOR") == "1" {
		profile := lipgloss.ColorProfile()
		dark := lipgloss.HasDarkBackground()
		lipgloss.SetColorProfile(termenv.ANSI256)
		lipgloss.SetHasDarkBackground(true)
		t.Cleanup(func() { lipgloss.SetColorProfile(profile); lipgloss.SetHasDarkBackground(dark) })
	} else {
		t.Setenv("NO_COLOR", "1")
	}
	for _, size := range [][2]int{{100, 32}, {80, 24}, {60, 12}} {
		for _, screen := range []string{"menu", "confirm", "progress"} {
			t.Run(fmt.Sprintf("%s-%dx%d", screen, size[0], size[1]), func(t *testing.T) {
				var view string
				switch screen {
				case "menu":
					m := newMenuModel(testInfo, fakeDeps())
					m.width, m.height = size[0], size[1]
					m.panel = panelStatus{kind: panelReachable, commit: "abc1234", baseURL: "http://127.0.0.1:48101"}
					view = m.View()
				case "confirm":
					m := upgradeChoice{title: "确认更新", body: "来源：GitHub · 最新正式发版\n目标提交：" + strings.Repeat("a", 40) + "\n\n" + strings.Repeat("修复说明，中文 é。", 30), items: []string{"取消更新", "更新并重启"}, width: size[0], height: size[1], viewport: viewport.New(10, 1)}
					m.resize()
					view = m.View()
				case "progress":
					task := completedUpgrade()
					task.State = "running"
					task.Phase = "building"
					task.UpdateSource = "github"
					task.UpdateChannel = "release"
					m := upgradeMonitor{width: size[0], height: size[1], viewport: viewport.New(10, 1), spinner: spinner.New(), start: time.Now(), follow: true}
					next, _ := m.Update(upgradeProgress{Task: task, Logs: strings.Repeat("构建日志：中文 é /path/to/build\n", 30)})
					view = next.(upgradeMonitor).View()
				}
				for _, line := range strings.Split(view, "\n") {
					if ansi.StringWidth(line) > size[0] {
						t.Fatalf("行宽超限：%q", line)
					}
				}
				if lipgloss.Height(strings.TrimRight(view, "\n")) > size[1] {
					t.Fatalf("高度 %d 超过 %d：\n%s", lipgloss.Height(strings.TrimRight(view, "\n")), size[1], view)
				}
				if dir := os.Getenv("ELYSIAN_CLI_VISUAL_DIR"); dir != "" {
					os.MkdirAll(dir, 0700)
					os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s-%dx%d.txt", screen, size[0], size[1])), []byte(view), 0600)
				}
			})
		}
	}
}

func TestUpgradeConfirmationDefaultsToCancel(t *testing.T) {
	m := upgradeChoice{items: []string{"取消", "更新"}, chosen: -1, width: 80, height: 24, viewport: viewport.New(80, 10)}
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if next.(upgradeChoice).chosen != 0 || cmd == nil {
		t.Fatal("确认应默认取消")
	}
}
