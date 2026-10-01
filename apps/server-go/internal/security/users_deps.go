package security

// 用户管理真实接线（getent/useradd/usermod/userdel/gpasswd/chpasswd；
// usersHostDeps.ts 的 Go 等价物）。硬边界由装配层注入的 Deps.Available 决定，
// 域包不读 env、不读 /.dockerenv。安全红线：所有命令数组传参执行，绝不拼 shell
// 字符串，也绝不手改 /etc/passwd、/etc/shadow 或 /etc/group——命令自带文件锁与
// 原子写；密码只走 chpasswd 的 stdin。

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// usersHostDeps 服务编排的全部宿主访问面（函数字段全部可注入）。
type usersHostDeps struct {
	runGetent   func(args []string) (string, error)
	runUseradd  func(args []string) (string, error)
	runUsermod  func(args []string) (string, error)
	runUserdel  func(args []string) (string, error)
	runGpasswd  func(args []string) (string, error)
	runChpasswd func(input string) (string, error)
	readText    func(path string) (string, error)
	exists      func(path string) bool
	remove      func(path string) error
	nowIso      func() string
}

// ExecFileLike execFile 的最小形状：runGetentViaExecFile 注入 fake exec 用。
type ExecFileLike func(name string, args []string) (stdout string, stderr string, err error)

// runGetentViaExecFile getent 的退出码语义适配：`getent passwd <不存在账号>` 以
// 退出码 2 结束且无输出（getent(1)：2 = 所查键在数据库中不存在）——这是「查无
// 结果」的正常语义，归一为空输出让上层按「无此账号」处理；其余退出码（如 1 的
// 库不存在）才是执行失败。服务层的查重、保护边界与删除回读都依赖这一点。
func runGetentViaExecFile(execFn ExecFileLike, args []string) (string, error) {
	stdout, stderr, err := execFn("getent", args)
	if err == nil {
		return stdout, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
		return "", nil
	}
	if detail := strings.TrimSpace(stderr); detail != "" {
		return "", errors.New(detail)
	}
	return "", errors.New(execDetail(err))
}

// runGetentReal 真实 getent 执行（退出码 2 归一为空输出）。
func runGetentReal(args []string) (string, error) {
	return runGetentViaExecFile(realExecFile, args)
}

// realExecFile exec.Command 的 ExecFileLike 适配。
func realExecFile(name string, args []string) (string, string, error) {
	return execContextOutput(context.Background(), name, args)
}

// execContextOutput 带 context 的命令执行（ctx 取消即中止子进程）。
func execContextOutput(ctx context.Context, name string, args []string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

// newRealUsersDeps 容器内真实依赖。
func newRealUsersDeps(now func() time.Time) *usersHostDeps {
	return &usersHostDeps{
		runGetent:  runGetentReal,
		runUseradd: func(args []string) (string, error) { return execToStdout("useradd", args) },
		runUsermod: func(args []string) (string, error) { return execToStdout("usermod", args) },
		runUserdel: func(args []string) (string, error) { return execToStdout("userdel", args) },
		runGpasswd: func(args []string) (string, error) { return execToStdout("gpasswd", args) },
		runChpasswd: func(input string) (string, error) {
			return runChpasswdViaStdin(spawnChpasswdPipe, input)
		},
		readText: func(path string) (string, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
		exists: func(path string) bool { _, err := os.Stat(path); return err == nil },
		remove: os.Remove,
		nowIso: func() string {
			t := time.Now()
			if now != nil {
				t = now()
			}
			return formatIsoMillis(t)
		},
	}
}
