package cli

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"strings"
)

type upgradeOptions struct {
	Source, Channel              string
	Yes                          bool
	StopContainers, StopServices []string
	StopPanel                    bool
}

func knownCommand(name string) bool {
	return name == "agent" || name == "resetpwd" || name == "upgrade" || name == "help"
}

// 参数解析在任何网络请求、凭据读取和终端初始化之前完成。
func parseCommand(args []string) (command string, opts upgradeOptions, help bool, err error) {
	if len(args) == 0 {
		return
	}
	command = args[0]
	if command == "help" {
		command = ""
		if len(args) == 2 && knownCommand(args[1]) {
			command = args[1]
		} else if len(args) != 1 {
			err = errors.New("未知帮助主题，用 ely help 查看可用命令")
			return
		}
		help = true
		return
	}
	if command == "-h" || command == "--help" {
		command = ""
		help = len(args) == 1
		if !help {
			err = errors.New("帮助命令不接受额外参数")
		}
		return
	}
	if command == "--version" {
		if len(args) != 1 {
			err = errors.New("版本命令不接受额外参数")
		}
		return
	}
	if !knownCommand(command) {
		err = fmt.Errorf("未知命令 %q，用 ely help 查看用法", command)
		command = ""
		return
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.BoolVar(&help, "h", false, "")
	flags.BoolVar(&help, "help", false, "")
	if command == "upgrade" {
		flags.StringVar(&opts.Source, "source", "github", "")
		flags.StringVar(&opts.Channel, "channel", "", "")
		flags.BoolVar(&opts.Yes, "yes", false, "")
		flags.BoolVar(&opts.Yes, "y", false, "")
		flags.BoolVar(&opts.StopPanel, "stop-panel", false, "")
		flags.Func("stop-container", "", func(value string) error {
			if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(value) {
				return errors.New("--stop-container 必须为完整的 64 位容器 ID")
			}
			opts.StopContainers = append(opts.StopContainers, value)
			return nil
		})
		flags.Func("stop-service", "", func(value string) error {
			if !regexp.MustCompile(`^[A-Za-z0-9_.@:-]+\.service$`).MatchString(value) || strings.HasPrefix(value, "-") {
				return errors.New("--stop-service 必须为精确的 .service 单元名")
			}
			opts.StopServices = append(opts.StopServices, value)
			return nil
		})
	}
	if parseErr := flags.Parse(args[1:]); parseErr != nil {
		err = fmt.Errorf("参数无效：%s", parseErr)
		return
	}
	if flags.NArg() != 0 {
		err = errors.New("命令不接受额外位置参数")
		return
	}
	if opts.Source != "" && opts.Source != "github" {
		err = errors.New("面板更新仅支持 GitHub，--source 只能为 github")
		return
	}
	if opts.Channel != "" && opts.Channel != "commit" && opts.Channel != "release" {
		err = errors.New("--channel 必须为 release 或 commit")
	}
	return
}

func printCommandHelp(w io.Writer, command string) {
	var text string
	switch command {
	case "agent":
		text = "用法：ely agent [-h|--help]\n\n直接进入 Agent 终端，需要交互式终端。复用已保存的 CLI 登录和会话草稿。\nF1 查看终端内快捷键；Esc 返回上级，Ctrl+C 退出。\n"
	case "resetpwd":
		text = "用法：ely resetpwd [-h|--help]\n\n重置面板管理员密码，输入两次新密码，至少 8 位。交互输入不回显。\n生产目录需要管理员权限：sudo ely resetpwd\n非交互时从标准输入按顺序读取两行密码；密码不能放在命令参数中。\n保存后全部登录会话失效。兼容入口：elysian resetpwd。\n"
	case "upgrade":
		text = "用法：ely upgrade [参数]\n\n参数：\n  --source github          更新来源固定为 GitHub，可省略\n  --channel release|commit 最新正式发版或最新提交；缺省高亮最新提交\n  --yes, -y                跳过最终确认，仍询问缺失选项\n  --help, -h               显示本帮助\n\n示例：\n  ely upgrade\n  ely upgrade --channel release\n  ely upgrade --source github --channel commit --yes\n\n非交互必须提供策略和 --yes，并已有有效 CLI 登录。\n复用面板更新任务，失败按原有机制回滚；来源失败不自动切换。\n再次运行优先恢复已有任务。Ctrl+C 仅退出监控，已接受的更新继续执行。\n"
	case "help":
		text = "用法：ely help [agent|resetpwd|upgrade|help]\n\n查看命令、参数、默认值和示例，无需面板运行或登录。\n也可使用 ely --help、ely upgrade --help。\n"
	default:
		text = "Elysian CLI（ely）— 服务器本地终端\n\n用法：\n  ely                    交互主菜单\n  ely agent              直接进入 Agent 终端\n  ely resetpwd           重置密码（生产目录：sudo ely resetpwd）\n  ely upgrade            通过 GitHub 更新面板，选择版本策略\n  ely help [命令]        查看全部命令或指定命令的参数\n  ely --help, -h         显示本帮助\n  ely --version          显示 CLI 版本\n\n示例：\n  ely help upgrade\n  ely upgrade --source github --channel release --yes\n\nAgent 和更新复用 CLI 登录。兼容脚本入口：elysian resetpwd、elysian panel-ports。\n"
	}
	if command == "upgrade" {
		text += "\n更新资源预检：\n  --stop-container <完整ID>  明确允许临时停止此容器，可重复\n  --stop-service <unit.service> 明确允许临时停止此服务，可重复\n  --stop-panel              允许构建前停止面板及 Agent，会暂时离线\n\n内存不足时先展示停机清单；--yes 不授权停止任何额外对象。更新结束恢复本次停止的业务，Agent 由用户手动继续。\n"
	}
	fmt.Fprint(w, text)
}
