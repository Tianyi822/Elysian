package cli

import (
	"fmt"
	"io"
	"os"
	"syscall"
)

// uninstallScriptPath 预编译安装随面板落盘的卸载脚本（install.sh 的 INSTALL_ROOT 固定
// 为 /opt/elysian，scripts 目录随版本目录一同放置）。脚本是卸载的唯一实现，本命令只
// 定位并转交，不复制其清理与核验逻辑。
const uninstallScriptPath = "/opt/elysian/current/scripts/uninstall.sh"

// execUninstallScript 以 syscall.Exec 转交进程：bash 完整接管终端、Ctrl+C 信号与退出
// 码，交互确认与 TUI 摘要均由脚本自身渲染；卸载中途删除 /opt/elysian 不影响持有已
// 打开脚本描述符的执行。Exec 成功不返回，失败按非零码退出。
func execUninstallScript(scriptArgs []string, stderr io.Writer) int {
	argv := append([]string{"bash", uninstallScriptPath}, scriptArgs...)
	if err := syscall.Exec("/bin/bash", argv, os.Environ()); err != nil {
		fmt.Fprintf(stderr, "启动卸载脚本失败：%v\n", err)
		return 1
	}
	return 0
}
