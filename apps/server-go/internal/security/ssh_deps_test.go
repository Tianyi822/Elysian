package security

// 宿主接线纯函数的对等测试（对齐 sshHostDeps.test.ts 与 usersHostDeps.test.ts 的
// 锚定行为）：pidfile+comm 双核实、字节尾读、chpasswd 行协议、getent 退出码语义。
// 子进程语义经真实 sh 小脚本驱动（容器内可用），不触达面板管理的系统文件。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResolveVerifiedSshdPid(t *testing.T) {
	cases := []struct {
		name      string
		pidFile   string
		pidFileOK bool
		comm      string
		commOK    bool
		wantOK    bool
		wantPid   int
	}{
		{"comm 为 sshd 才回 pid", "123\n", true, "sshd\n", true, true, 123},
		{"comm 为 bash 回 false", "123\n", true, "bash\n", true, false, 0},
		{"comm 为 cron 回 false", "123\n", true, "cron\n", true, false, 0},
		{"comm 读不到回 false", "123\n", true, "", false, false, 0},
		{"pidfile 缺失回 false", "", false, "", false, false, 0},
		{"pidfile 为空回 false", "\n", true, "", false, false, 0},
		{"pidfile 非法回 false", "abc\n", true, "sshd\n", true, false, 0},
		{"pidfile 带尾随内容取前缀数字", "77 \n", true, "sshd\n", true, true, 77},
	}
	for _, c := range cases {
		probe := sshdPidProbe{
			readPidFile: func() (string, bool) { return c.pidFile, c.pidFileOK },
			readProcComm: func(pid int) (string, bool) {
				if !c.commOK {
					return "", false
				}
				if pid != c.wantPid && c.wantOK {
					return "", false
				}
				return c.comm, true
			},
		}
		// wantOK 且 pid 不匹配期望时 comm 也可判定：readProcComm 对任意 pid 回 comm。
		if c.wantOK {
			probe.readProcComm = func(pid int) (string, bool) { return c.comm, true }
		}
		pid, ok := resolveVerifiedSshdPid(probe)
		if ok != c.wantOK || (ok && pid != c.wantPid) {
			t.Errorf("%s：resolveVerifiedSshdPid = (%d, %v)，want (%d, %v)", c.name, pid, ok, c.wantPid, c.wantOK)
		}
	}
}

func TestReadTextTailFromFile真实文件语义(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sshd.log")
	content := "第一行\n第二行\n第三行\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写测试文件失败：%v", err)
	}
	// 预算够：返回全文。
	got, err := readTextTailFromFile(path, int64(len(content)+10))
	if err != nil || got != content {
		t.Errorf("预算足够应返回全文：(%q, %v)", got, err)
	}
	// 预算小：返回后缀且起于整行边界。
	got, err = readTextTailFromFile(path, 10)
	if err != nil {
		t.Fatalf("尾读失败：%v", err)
	}
	if !strings.HasSuffix(content, got) {
		t.Errorf("尾读结果应是文件后缀：%q", got)
	}
	if idx := strings.IndexByte(got, '\n'); idx >= 0 && idx != len(got)-1 {
		// 中间换行可以有（多行后缀），但首行必须完整——由下面的纯函数测试覆盖边界。
	}
	// 预算落在「第三行」中间：发生截断，丢弃不完整首行后起于整行边界。
	got, err = readTextTailFromFile(path, 12)
	if err != nil {
		t.Fatalf("尾读失败：%v", err)
	}
	if !strings.HasSuffix(content, got) {
		t.Errorf("截断结果应是文件后缀：%q", got)
	}
	if !strings.HasPrefix(got, "第三行") {
		t.Errorf("截断首行应丢弃不完整段落（起于整行边界）：%q", got)
	}
}

func TestTextTailOf截断首行丢弃(t *testing.T) {
	if got := textTailOf("abc", false); got != "abc" {
		t.Errorf("未截断原样返回：%q", got)
	}
	if got := textTailOf("abcd\nef\ng", true); got != "ef\ng" {
		t.Errorf("截断时丢不完整首行：%q", got)
	}
	if got := textTailOf("abcdef", true); got != "" {
		t.Errorf("无换行时整段丢弃：%q", got)
	}
}

// ---------- chpasswd 行协议 ----------

// errExitStatus 模拟 *exec.ExitError 的等待错误（非零退出）。
func errExitStatus(code int) error {
	return fmt.Errorf("exit status %d", code)
}

type chpasswdTestInput struct {
	received strings.Builder
	writeErr error
	closeErr error
	closed   bool
}

func (i *chpasswdTestInput) Write(p []byte) (int, error) {
	if i.writeErr != nil {
		return 0, i.writeErr
	}
	return i.received.Write(p)
}

func (i *chpasswdTestInput) Close() error {
	i.closed = true
	return i.closeErr
}

type fakeChpasswdProc struct {
	stdin    io.WriteCloser
	stderr   io.Writer
	detail   string
	exitCode int
	waited   bool
}

func (p *fakeChpasswdProc) Stdin() io.WriteCloser { return p.stdin }
func (p *fakeChpasswdProc) Wait() error {
	p.waited = true
	if p.detail != "" {
		_, _ = io.WriteString(p.stderr, p.detail)
	}
	if p.exitCode != 0 {
		return errExitStatus(p.exitCode)
	}
	return nil
}
func (p *fakeChpasswdProc) ExitCode() int { return p.exitCode }

func TestRunChpasswdViaStdin正常路径(t *testing.T) {
	stdin := &chpasswdTestInput{}
	proc := &fakeChpasswdProc{stdin: stdin}
	spawn := func(io.Writer) (chpasswdChild, error) { return proc, nil }
	if _, err := runChpasswdViaStdin(spawn, "root:新密码"); err != nil {
		t.Fatalf("正常路径应成功：%v", err)
	}
	if stdin.received.String() != "root:新密码" || !stdin.closed || !proc.waited {
		t.Fatal("正常路径应逐字写入 stdin，关闭输入并回收进程")
	}
}

func TestRunChpasswdViaStdin非零退出(t *testing.T) {
	spawn := func(stderr io.Writer) (chpasswdChild, error) {
		return &fakeChpasswdProc{stdin: &chpasswdTestInput{}, stderr: stderr, detail: "chpasswd: 密码过期信息更新失败\n", exitCode: 1}, nil
	}
	_, err := runChpasswdViaStdin(spawn, "root:x")
	if err == nil || err.Error() != "chpasswd: 密码过期信息更新失败" {
		t.Errorf("非零退出应取 stderr trim：%v", err)
	}

	spawn = func(io.Writer) (chpasswdChild, error) {
		return &fakeChpasswdProc{stdin: &chpasswdTestInput{}, exitCode: 1}, nil
	}
	_, err = runChpasswdViaStdin(spawn, "root:x")
	if err == nil || err.Error() != "chpasswd 退出码 1" {
		t.Errorf("无 stderr 回退退出码文案：%v", err)
	}
}

func TestRunChpasswdViaStdin管道破裂(t *testing.T) {
	stdin := &chpasswdTestInput{writeErr: io.ErrClosedPipe}
	proc := &fakeChpasswdProc{stdin: stdin, exitCode: 1}
	spawn := func(io.Writer) (chpasswdChild, error) { return proc, nil }
	_, err := runChpasswdViaStdin(spawn, "root:x")
	if !errors.Is(err, io.ErrClosedPipe) {
		t.Errorf("stdin 写失败应原样返回：%v", err)
	}
	if !stdin.closed || !proc.waited {
		t.Error("stdin 写失败后仍须关闭输入并回收已启动的进程")
	}
}

func TestRunChpasswdViaStdin关闭错误(t *testing.T) {
	stdin := &chpasswdTestInput{closeErr: io.ErrClosedPipe}
	proc := &fakeChpasswdProc{stdin: stdin, exitCode: 1}
	spawn := func(io.Writer) (chpasswdChild, error) { return proc, nil }
	if _, err := runChpasswdViaStdin(spawn, "root:x"); !errors.Is(err, io.ErrClosedPipe) || !proc.waited {
		t.Fatalf("stdin 关闭失败应原样返回，并回收进程：%v", err)
	}
}

func TestRunChpasswdViaStdin管道未建立(t *testing.T) {
	spawn := func(io.Writer) (chpasswdChild, error) {
		return &fakeChpasswdProc{}, nil
	}
	_, err := runChpasswdViaStdin(spawn, "root:x")
	if err == nil || err.Error() != "chpasswd 子进程的标准管道未建立" {
		t.Errorf("stdio 未建立应中文拒绝：%v", err)
	}
}

func TestRunChpasswdViaStdin启动失败(t *testing.T) {
	spawn := func(io.Writer) (chpasswdChild, error) { return nil, errors.New("spawn 失败") }
	if _, err := runChpasswdViaStdin(spawn, "root:x"); err == nil || err.Error() != "spawn 失败" {
		t.Errorf("spawn 失败应原样带回：%v", err)
	}
}

func TestSpawnChpasswdPipeDiscardsStdoutAndCollectsStderr(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	const child = `#!/bin/sh
IFS= read -r line || [ "$line" = "fixture:input" ] || exit 7
[ "$line" = "fixture:input" ] || exit 7
i=0
while [ "$i" -lt 2048 ]; do
	printf '%s\n' 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	i=$((i+1))
done
printf '%s\n' '测试 stderr' >&2
exit 3
`
	if err := os.WriteFile(filepath.Join(dir, "chpasswd"), []byte(child), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := runChpasswdViaStdin(spawnChpasswdPipe, "fixture:input"); err == nil || err.Error() != "测试 stderr" {
		t.Fatalf("应丢弃 stdout 并保留完整 stderr：%v", err)
	}
}

// ---------- getent 退出码语义（真实 sh 子进程驱动） ----------

// shExec 用真实 sh 脚本模拟一次命令执行（容器内可用；不触达面板管理的系统文件）。
func shExec(script string) ExecFileLike {
	return func(name string, args []string) (string, string, error) {
		cmd := exec.Command("sh", "-c", script)
		var stdout, stderr strings.Builder
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		return stdout.String(), stderr.String(), err
	}
}

func TestRunGetentViaExecFile退出码语义(t *testing.T) {
	// 退出码 2 → 空输出（查无结果的正常语义）。
	got, err := runGetentViaExecFile(shExec("exit 2"), []string{"passwd", "missing"})
	if err != nil || got != "" {
		t.Errorf("退出码 2 应归一为空输出：(%q, %v)", got, err)
	}
	// 退出码 1 带 stderr → stderr 详情。
	_, err = runGetentViaExecFile(shExec("echo 库不存在 >&2; exit 1"), []string{"passwd"})
	if err == nil || err.Error() != "库不存在" {
		t.Errorf("退出码 1 带 stderr 应取 stderr：%v", err)
	}
	// 退出码 1 无 stderr → 错误 message（exit status 1）。
	_, err = runGetentViaExecFile(shExec("exit 1"), []string{"passwd"})
	if err == nil || !strings.Contains(err.Error(), "exit status 1") {
		t.Errorf("退出码 1 无 stderr 应回退错误消息：%v", err)
	}
	// 成功原样 stdout。
	line := "root:x:0:0:root:/root:/bin/bash"
	got, err = runGetentViaExecFile(shExec("printf '%s\\n' "+line), []string{"passwd", "root"})
	if err != nil || strings.TrimSpace(got) != line {
		t.Errorf("成功应原样 stdout：(%q, %v)", got, err)
	}
}

func TestSystemAccounts接缝(t *testing.T) {
	ctx := context.Background()
	line := "root:x:0:0:root:/root:/bin/bash\nelysian:x:1000:1000::/home/elysian:/bin/bash\n"
	expand := shExec("printf '%b' '" + strings.ReplaceAll(line, "\n", "\\n") + "'")
	accounts := &systemAccounts{exec: func(ctx context.Context, name string, args []string) (string, string, error) {
		return expand(name, args)
	}}
	all, err := accounts.PasswdAll(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("PasswdAll 应解析全部记录：(%d, %v)", len(all), err)
	}
	// 退出码 2 归一 (nil, nil)。
	missing := &systemAccounts{exec: func(ctx context.Context, name string, args []string) (string, string, error) {
		return shExec("exit 2")(name, args)
	}}
	rec, err := missing.PasswdByName(ctx, "missing")
	if err != nil || rec != nil {
		t.Errorf("查无结果应为 (nil, nil)：(%v, %v)", rec, err)
	}
	// 命中按名返回。
	// 真实 `getent passwd <name>` 只回匹配行：fake 按查询名过滤。
	hit := &systemAccounts{exec: func(ctx context.Context, name string, args []string) (string, string, error) {
		query := args[len(args)-1]
		for _, l := range strings.Split(line, "\n") {
			if strings.HasPrefix(l, query+":") {
				return l, "", nil
			}
		}
		return "", "", nil
	}}
	rec, err = hit.PasswdByName(ctx, "elysian")
	if err != nil || rec == nil || rec.Name != "elysian" || rec.UID != 1000 {
		t.Errorf("按名反查失败：(%v, %v)", rec, err)
	}
}

// ---------- sshd 启动辅助（真实接线专用） ----------

func TestEnsureSshdPrivSepDirIdempotent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "run", "sshd")
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("首次创建：%v", err)
	}
	if err := ensureSshdPrivSepDir(dir); err != nil {
		t.Fatalf("已存在应幂等：%v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("应为目录：%v", err)
	}
}

func TestFileSizeOf(t *testing.T) {
	dir := t.TempDir()
	if fileSizeOf(filepath.Join(dir, "none")) != 0 {
		t.Fatal("不存在应按 0")
	}
	path := filepath.Join(dir, "f")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if fileSizeOf(path) != 5 {
		t.Fatalf("应为 5：%d", fileSizeOf(path))
	}
}

func TestReadPidFilePid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sshd.pid")
	if readPidFilePid(path) != 0 {
		t.Fatal("不存在应按 0")
	}
	if err := os.WriteFile(path, []byte(" 4242\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if readPidFilePid(path) != 4242 {
		t.Fatalf("应解析 4242：%d", readPidFilePid(path))
	}
	if err := os.WriteFile(path, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	if readPidFilePid(path) != 0 {
		t.Fatal("非数字应按 0")
	}
}

func TestReadLogDeltaLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sshd.log")
	if err := os.WriteFile(path, []byte("old line\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	offset := fileSizeOf(path)
	if err := os.WriteFile(path, []byte("old line\nBind to port 22 on 0.0.0.0 failed: Address already in use.\nCannot bind any address.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	detail := readLogDeltaLines(path, offset, 1024)
	if !strings.Contains(detail, "Address already in use") || !strings.Contains(detail, "Cannot bind any address") {
		t.Fatalf("增量应含失败原因：%q", detail)
	}
	if strings.Contains(detail, "old line") {
		t.Fatalf("不应包含 offset 之前的旧内容：%q", detail)
	}
	if got := readLogDeltaLines(path, fileSizeOf(path), 1024); got != "" {
		t.Fatalf("无增量应空串：%q", got)
	}
	if got := readLogDeltaLines(path+".none", 0, 1024); got != "" {
		t.Fatalf("文件不存在应空串：%q", got)
	}
}

func TestWaitNewSshdPid(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "sshd.pid")
	if err := os.WriteFile(pidPath, []byte("100\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if waitNewSshdPid(pidPath, 100, 150*time.Millisecond) {
		t.Fatal("pid 未变化应超时返回 false")
	}
	if err := os.WriteFile(pidPath, []byte("200\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitNewSshdPid(pidPath, 100, time.Second) {
		t.Fatal("出现新 pid 应返回 true")
	}
	if !waitNewSshdPid(pidPath, 0, time.Second) {
		t.Fatal("先前无 pid、现在出现也应返回 true")
	}
}
