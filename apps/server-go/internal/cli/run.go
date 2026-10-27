// Package cli 提供 ely 全局命令的交互入口（CLI 方案 §2／§5）：同一 elysian 单二进制
// 经 argv0 别名分发进入（cmd/elysian 顶部判定 Base(argv0)=="ely"），提供主菜单
// （Agent／重置密码／更新／帮助／退出）与直接子命令；不进入服务端装配。
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
	agentDeps  func() tui.Deps
	runAgent   func(*os.File, io.Writer) error
	runUpgrade func(upgradeOptions, *os.File, io.Writer, io.Writer) int
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
	d.runAgent = func(in *os.File, out io.Writer) error { return tui.Run(in, out, d.agentDeps()) }
	d.runUpgrade = func(opts upgradeOptions, in *os.File, out, errOut io.Writer) int {
		return runUpgrade(opts, in, out, errOut, d)
	}
	return d
}

// Run 按显式子命令分派；无参数进入菜单，帮助与版本无需初始化终端或连接面板。
// 参数错误回 2，业务入口保留自己的执行结果；elysian 维护内部命令不经本入口。
func Run(info Info, args []string, stdin *os.File, stdout, stderr io.Writer) int {
	return runWithDeps(info, args, stdin, stdout, stderr, productionDeps())
}

func runWithDeps(info Info, args []string, stdin *os.File, stdout, stderr io.Writer, d deps) int {
	command, opts, help, err := parseCommand(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		printCommandHelp(stderr, command)
		return 2
	}
	if help {
		printCommandHelp(stdout, command)
		return 0
	}
	if len(args) == 0 {
		if stdin == nil || !isatty.IsTerminal(stdin.Fd()) {
			fmt.Fprintln(stderr, "ely 需要交互式终端；可用 ely help 查看直接命令，旧脚本仍可使用 elysian 子命令。")
			return 1
		}
		return runMenu(info, stdin, stdout, stderr, d)
	}
	switch command {
	case "--version":
		printVersion(stdout, info)
		return 0
	case "resetpwd":
		return runResetPassword(stdout, stdin, d)
	case "agent":
		if stdin == nil || !isatty.IsTerminal(stdin.Fd()) {
			fmt.Fprintln(stderr, "ely agent 需要交互式终端；参数帮助：ely help agent")
			return 1
		}
		run := d.runAgent
		if run == nil {
			run = func(in *os.File, out io.Writer) error { return tui.Run(in, out, d.agentDeps()) }
		}
		if err := run(stdin, stdout); err != nil && !errors.Is(err, tui.ErrExitCLI) {
			fmt.Fprintln(stderr, "Agent 终端运行失败：", err)
			return 1
		}
		return 0
	case "upgrade":
		if stdin == nil || !isatty.IsTerminal(stdin.Fd()) {
			if opts.Source == "" || opts.Channel == "" || !opts.Yes {
				fmt.Fprintln(stderr, "非交互更新必须提供 --source、--channel 和 --yes；用 ely help upgrade 查看示例。")
				return 2
			}
		}
		return d.runUpgrade(opts, stdin, stdout, stderr)
	}
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
		case menuActionUpgrade:
			if d.runUpgrade(upgradeOptions{}, stdin, stdout, stderr) == 130 {
				return 0
			}
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

// printUsage 输出全局命令与帮助入口。
func printUsage(w io.Writer) {
	printCommandHelp(w, "")
}
