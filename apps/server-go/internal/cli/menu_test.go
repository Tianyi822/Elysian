package cli

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// 菜单模型 Update 纯状态机测试（CLI 方案 §8）：方向键与 j/k 导航（含回绕）、Enter
// 确认（Agent 说明页／重置密码退出／退出）、Esc 与 Ctrl+C 退出路径、面板版本回填与
// 五态头部呈现。全部为纯函数断言，不起真实 TTY。

func press(t *testing.T, m menuModel, msg tea.Msg) menuModel {
	t.Helper()
	next, _ := m.Update(msg)
	mm, ok := next.(menuModel)
	if !ok {
		t.Fatalf("Update 应返回 menuModel，得到 %T", next)
	}
	return mm
}

func pressWithCmd(t *testing.T, m menuModel, msg tea.Msg) (menuModel, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	mm, ok := next.(menuModel)
	if !ok {
		t.Fatalf("Update 应返回 menuModel，得到 %T", next)
	}
	return mm, cmd
}

func quits(t *testing.T, cmd tea.Cmd) bool {
	t.Helper()
	if cmd == nil {
		return false
	}
	_, ok := cmd().(tea.QuitMsg)
	return ok
}

func keyDown() tea.Msg  { return tea.KeyMsg{Type: tea.KeyDown} }
func keyUp() tea.Msg    { return tea.KeyMsg{Type: tea.KeyUp} }
func keyEnter() tea.Msg { return tea.KeyMsg{Type: tea.KeyEnter} }
func keyEsc() tea.Msg   { return tea.KeyMsg{Type: tea.KeyEsc} }
func keyCtrlC() tea.Msg { return tea.KeyMsg{Type: tea.KeyCtrlC} }
func keyRune(s string) tea.Msg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

func TestMenuNavigationWraps(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	if m.cursor != 0 {
		t.Fatalf("初始焦点应在第一项，得到 %d", m.cursor)
	}
	m = press(t, m, keyDown())
	if m.cursor != 1 {
		t.Fatalf("下移应到第二项，得到 %d", m.cursor)
	}
	m = press(t, m, keyDown())
	if m.cursor != 2 {
		t.Fatalf("下移应到第三项，得到 %d", m.cursor)
	}
	m = press(t, m, keyDown())
	m = press(t, m, keyDown())
	m = press(t, m, keyDown())
	if m.cursor != 0 {
		t.Fatalf("末尾下移应回绕到第一项，得到 %d", m.cursor)
	}
	m = press(t, m, keyUp())
	if m.cursor != 4 {
		t.Fatalf("顶部上移应回绕到末项，得到 %d", m.cursor)
	}
}

func TestMenuNavigationVimKeys(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m = press(t, m, keyRune("j"))
	if m.cursor != 1 {
		t.Fatalf("j 应下移到第二项，得到 %d", m.cursor)
	}
	m = press(t, m, keyRune("k"))
	if m.cursor != 0 {
		t.Fatalf("k 应上移到第一项，得到 %d", m.cursor)
	}
}

func TestMenuBatchedRunesReducedPerKey(t *testing.T) {
	// 快速连按／粘贴时多个 rune 以单条 KeyMsg 到达（String() 为 "jj"），应逐键归约。
	m := newMenuModel(testInfo, fakeDeps())
	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("jj")})
	if m.cursor != 2 {
		t.Fatalf("批量 jj 应等价两次下移到第三项，得到 %d", m.cursor)
	}
	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("kk")})
	if m.cursor != 0 {
		t.Fatalf("批量 kk 应等价两次上移回第一项，得到 %d", m.cursor)
	}
	// 无关字符批量到达不改变焦点。
	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("xy")})
	if m.cursor != 0 {
		t.Fatalf("无关字符不应移动焦点，得到 %d", m.cursor)
	}
}

func TestMenuEnterResetPasswordQuitsWithAction(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m = press(t, m, keyDown()) // 焦点：重置密码
	m, cmd := pressWithCmd(t, m, keyEnter())
	if m.action != menuActionResetPassword {
		t.Fatalf("Enter 应选中重置密码，得到 action=%d", m.action)
	}
	if !quits(t, cmd) {
		t.Fatal("选中重置密码应退出菜单程序（改密流程自管 termios）")
	}
}

func TestMenuEnterExitQuitsWithAction(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m = press(t, m, keyUp()) // 焦点：退出
	m, cmd := pressWithCmd(t, m, keyEnter())
	if m.action != menuActionExit || !quits(t, cmd) {
		t.Fatalf("Enter 应选中退出：action=%d quits=%v", m.action, quits(t, cmd))
	}
}

func TestMenuEnterAgentQuitsWithAction(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m, cmd := pressWithCmd(t, m, keyEnter()) // 焦点：Agent 终端
	if m.action != menuActionAgent {
		t.Fatalf("Enter 应选中 Agent 终端，得到 action=%d", m.action)
	}
	if !quits(t, cmd) {
		t.Fatal("Agent 终端应退出菜单程序（终端让渡给 TUI 流程）")
	}
}

func TestMenuEscAndCtrlCQuitFromMain(t *testing.T) {
	m, cmd := pressWithCmd(t, newMenuModel(testInfo, fakeDeps()), keyEsc())
	if m.action != menuActionExit || !quits(t, cmd) {
		t.Fatalf("主菜单 Esc 应退出（已无上级可返）：action=%d", m.action)
	}
	m, cmd = pressWithCmd(t, newMenuModel(testInfo, fakeDeps()), keyCtrlC())
	if m.action != menuActionExit || !quits(t, cmd) {
		t.Fatalf("Ctrl+C 应即时退出：action=%d", m.action)
	}
}

func TestMenuCtrlCQuitsFromNotice(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	m, _ = pressWithCmd(t, m, keyEnter()) // 进入说明页
	m, cmd := pressWithCmd(t, m, keyCtrlC())
	if m.action != menuActionExit || !quits(t, cmd) {
		t.Fatalf("说明页 Ctrl+C 应即时退出：action=%d", m.action)
	}
}

func TestMenuViewRendersItemsAndVersions(t *testing.T) {
	m := newMenuModel(testInfo, fakeDeps())
	view := m.View()
	for _, want := range []string{"Agent 终端", "重置密码", "退出", "CLI 版本：abc1234", "构建于", "面板版本：检测中", "↑/↓"} {
		if !strings.Contains(view, want) {
			t.Errorf("菜单视图应含 %q：%q", want, view)
		}
	}
	// 初始焦点在第一项：选中标记指向 Agent 终端。
	if !strings.Contains(view, "❯ Agent 终端") || strings.Contains(view, "❯ 重置密码") {
		t.Errorf("初始焦点标记应只在第一项：%q", view)
	}
}

func TestMenuPanelStatusHeaderView(t *testing.T) {
	base := newMenuModel(testInfo, fakeDeps())

	same := base
	same.panel = panelStatus{kind: panelReachable, commit: "abc1234", baseURL: "http://127.0.0.1:48101"}
	if v := same.View(); !strings.Contains(v, "面板版本：abc1234") || strings.Contains(v, "不一致") {
		t.Errorf("版本一致时不标注不一致：%q", v)
	}

	mismatch := base
	mismatch.panel = panelStatus{kind: panelReachable, commit: "deadbeef"}
	v := mismatch.View()
	if !strings.Contains(v, "面板与 CLI 版本不一致（面板 deadbeef / CLI abc1234）") {
		t.Errorf("版本不一致时应双值标注：%q", v)
	}

	noCommit := base
	noCommit.panel = panelStatus{kind: panelReachable}
	if v := noCommit.View(); !strings.Contains(v, "面板可达（未上报版本）") {
		t.Errorf("面板可达但未上报 commit 时应如实说明：%q", v)
	}

	notRunning := base
	notRunning.panel = panelStatus{kind: panelNotRunning}
	if v := notRunning.View(); !strings.Contains(v, "面板未启动") || !strings.Contains(v, "sudo systemctl start elysian") {
		t.Errorf("未启动态应给出启动指引：%q", v)
	}

	unreachable := base
	unreachable.panel = panelStatus{kind: panelUnreachable, detail: "健康检查返回 500 Internal Server Error"}
	v = unreachable.View()
	if !strings.Contains(v, "面板连接异常") || !strings.Contains(v, "健康检查返回 500") || !strings.Contains(v, "sudo ss -ltnp") {
		t.Errorf("连接异常态应带原始详情与排查指引：%q", v)
	}
}

func TestMenuInitProbesPanel(t *testing.T) {
	probed := false
	d := fakeDeps()
	d.probePanel = func(context.Context) panelStatus {
		probed = true
		return panelStatus{kind: panelReachable, commit: "abc1234"}
	}
	m := newMenuModel(testInfo, d)
	cmd := m.Init()
	if cmd == nil {
		t.Fatal("Init 应发起面板探测")
	}
	msg, ok := cmd().(panelStatusMsg)
	if !ok {
		t.Fatalf("探测命令应回 panelStatusMsg，得到 %T", msg)
	}
	if !probed {
		t.Fatal("探测应经 deps 出口执行")
	}
	next, _ := m.Update(msg)
	if next.(menuModel).panel.commit != "abc1234" {
		t.Fatal("探测结果应回填模型")
	}
}
