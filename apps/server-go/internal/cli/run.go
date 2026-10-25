// Package cli 提供 ely 全局命令的交互入口（CLI 方案 §2／§5）：同一 elysian 单二进制
// 经 argv0 别名分发进入（cmd/elysian 顶部判定 Base(argv0)=="ely"），提供主菜单
// （Agent 终端／重置密码／退出）、--version／--help 与非 TTY 检测；不进入服务端装配。
//
// CLI 与面板的通信只走 127.0.0.1 回环 HTTP（面板发现与五态区分见 panelhost.go）；
// 重置密码复用 internal/auth 的既有安全流程，本地授权门禁收口在本包。
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"elysian/server/internal/auth"
	"elysian/server/internal/cli/tui"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-isatty"
)

// Info CLI 自身版本事实：与面板同一二进制，取 ldflags 注入值（构建注入目标
// internal/panel.Commit/BuildTime，由 cmd/elysian 转交，本包不依赖 panel 域）。
type Info struct {
	Commit    string
	BuildTime string
}

// deps Run 的可注入出口：环境变量、文件系统、euid、面板探测与改密执行全部经此注入，
// 单测用 fake 复现解析次序与门禁分支，不真起交互与网络。
type deps struct {
	getenv     func(string) string
	userHome   func() (string, error)
	fileExists func(string) bool
	geteuid    func() int
	// probePanel 探测面板后端（生产为 panelhost 的 health 探测实现）。
	probePanel func(ctx context.Context) panelStatus
	// runResetAt 执行既有改密流程（生产为 auth.RunResetPasswordCLIAt）。
	runResetAt func(panelHome string, stdin io.Reader, stdout io.Writer) int
	// agentDeps 构造 Agent 终端依赖（生产为 productionTUIDeps；测试注入）。
	agentDeps func() tui.Deps
}

// productionDeps 装配真实出口。
func productionDeps() deps {
	d := deps{
		getenv:     os.Getenv,
		userHome:   os.UserHomeDir,
		fileExists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		geteuid:    os.Geteuid,
		runResetAt: auth.RunResetPasswordCLIAt,
	}
	d.probePanel = func(ctx context.Context) panelStatus {
		home, err := resolvePanelHome(d.getenv, d.fileExists, d.userHome)
		if err != nil {
			return panelStatus{kind: panelUnreachable, detail: err.Error()}
		}
		return probePanelAt(ctx, home, defaultBackendPort)
	}
	d.agentDeps = func() tui.Deps { return productionTUIDeps(d) }
	return d
}

// Run ely 主入口（argv0 已由 cmd/elysian 判定为 ely），返回进程退出码。参数语义
// （CLI 方案 §2）：无参数进交互主菜单（stdin 非 TTY 时明确提示并以 1 退出）；
// --version／--help 打印后回 0；其余任意参数（含透传 elysian 子命令形态）打印用法
// 并回 2，不与 `elysian resetpwd` 等脚本通道混淆。
func Run(info Info, args []string, stdin *os.File, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		if stdin == nil || !isatty.IsTerminal(stdin.Fd()) {
			fmt.Fprintln(stderr, "ely 需要交互式终端，请在服务器终端直接运行；脚本场景请使用 elysian 子命令。")
			return 1
		}
		return runMenu(info, stdin, stdout, stderr, productionDeps())
	}
	if len(args) == 1 {
		switch args[0] {
		case "--version":
			printVersion(stdout, info)
			return 0
		case "--help":
			printUsage(stdout)
			return 0
		}
	}
	printUsage(stderr)
	return 2
}

// runMenu 菜单主循环：菜单程序退出后按最终 action 分派——退出／Esc／Ctrl+C 回 0；
// 重置密码与 Agent 终端都先退出菜单程序（终端让渡给各自流程），完成后重新进入
// 菜单。每轮重建模型，面板版本随每轮重新探测。
func runMenu(info Info, stdin *os.File, stdout, stderr io.Writer, d deps) int {
	for {
		prog := tea.NewProgram(newMenuModel(info, d), tea.WithInput(stdin), tea.WithOutput(stdout))
		final, err := prog.Run()
		if err != nil {
			// Ctrl+C 经信号路径到达（raw mode 之外的兜底）同样视为即时退出，退出码 0。
			if errors.Is(err, tea.ErrInterrupted) || errors.Is(err, tea.ErrProgramKilled) {
				return 0
			}
			fmt.Fprintf(stderr, "菜单运行失败：%v\n", err)
			return 1
		}
		// 模型全程为值语义（menuModel 值类型），断言按值类型取回最终状态。
		m, ok := final.(menuModel)
		if !ok {
			return 0
		}
		switch m.action {
		case menuActionResetPassword:
			runResetPassword(stdout, stdin, d)
			fmt.Fprintln(stdout)
		case menuActionAgent:
			if err := tui.Run(stdin, stdout, d.agentDeps()); err != nil {
				if errors.Is(err, tui.ErrExitCLI) {
					return 0
				}
				fmt.Fprintf(stderr, "Agent 终端运行失败：%v\n", err)
				return 1
			}
			fmt.Fprintln(stdout)
		default:
			return 0
		}
	}
}

// printVersion 输出 CLI 版本（与面板同源，安装冒烟以输出含构建 commit 为准）。
func printVersion(w io.Writer, info Info) {
	fmt.Fprintln(w, "Elysian CLI（ely）")
	fmt.Fprintf(w, "版本：%s\n", info.Commit)
	fmt.Fprintf(w, "构建时间：%s\n", info.BuildTime)
}

// printUsage 输出用法；脚本与自动化一律引导到 elysian 子命令。
func printUsage(w io.Writer) {
	fmt.Fprintln(w, "ely — Elysian 服务器本地终端")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "用法：")
	fmt.Fprintln(w, "  ely              交互主菜单（Agent 终端／重置密码／退出；需要交互式终端）")
	fmt.Fprintln(w, "  ely --version    显示 CLI 版本")
	fmt.Fprintln(w, "  ely --help       显示本帮助")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "脚本与自动化场景请使用 elysian 子命令（如 elysian resetpwd、elysian panel-ports）。")
}
