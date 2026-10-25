package cli

import (
	"fmt"
	"io"
	"path/filepath"
)

// ely 菜单「重置密码」入口（CLI 方案 §5）：先做本地授权门禁（auth 纯函数不动），再
// 把解析出的面板数据根原样打印并转交既有改密流程 auth.RunResetPasswordCLIAt——两次
// 无回显隐藏输入（TTY）、两次一致校验、UTF-16 口径 ≥8 位、scrypt 哈希、writeFileAtomic
// 原子落盘、pwdEpoch 使全部会话（web 与 cli 两类）下次请求即 401，全部为现行实现。
//
// 门禁口径：解析目标为 /var/lib/elysian/.Elysian（生产路径）且执行者非 root 时直接
// 拒绝并提示 sudo ely，挡住「普通用户在自己 home 建一份无关凭据却显示成功」的误导；
// 目标在 $HOME 下的开发形态放行（开发者改自己面板的密码是正当场景）。菜单整体要求
// TTY，本入口不做管道模式；脚本场景继续用 `elysian resetpwd` 的两行管道语义。

// runResetPassword 执行门禁与既有改密流程；结果打印交由流程自身，完成后返回（菜单
// 循环重新进入主菜单）。密码明文不经命令行参数、不落任何日志，输出只含路径提示与
// 流程自身的提示与结果。
func runResetPassword(stdout io.Writer, stdin io.Reader, d deps) {
	home, err := resolvePanelHome(d.getenv, d.fileExists, d.userHome)
	if err != nil {
		fmt.Fprintln(stdout, "✗ 无法定位面板数据目录："+err.Error())
		return
	}
	credentials := filepath.Join(home, "config", "panel-credentials.json")
	if isProductionPanelHome(home) && d.geteuid() != 0 {
		fmt.Fprintln(stdout, "✗ 需要管理员权限：sudo ely")
		fmt.Fprintln(stdout, "  面板凭据文件："+credentials)
		return
	}
	fmt.Fprintln(stdout, "面板凭据文件："+credentials)
	fmt.Fprintln(stdout, "")
	d.runResetAt(home, stdin, stdout)
}
