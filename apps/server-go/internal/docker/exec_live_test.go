package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 仅创建自己的临时容器。可选的官方程序安装完成后立即断网，不复用或修改已有容器。
func liveDockerTerminalContainer(t *testing.T, installPrograms bool) execRunner {
	t.Helper()
	socket := os.Getenv("ELYSIAN_TEST_DOCKER_EXEC_SOCKET")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	transport := newUnixTransport(socket)
	networkMode := "none"
	memory := 128 * 1024 * 1024
	if installPrograms {
		networkMode = "bridge"
		memory = 256 * 1024 * 1024
	}
	body, _ := json.Marshal(map[string]any{
		"Image": "elysian-go-dev-go", "Cmd": []string{"sleep", "infinity"},
		"Labels":     map[string]string{"elysian.test": "raw-terminal"},
		"HostConfig": map[string]any{"NetworkMode": networkMode, "Memory": memory, "PidsLimit": 64, "SecurityOpt": []string{"no-new-privileges:true"}},
	})
	response, err := transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodPost, Path: "/containers/create", Body: body, Timeout: 10 * time.Second, MaxBytes: 64 * 1024})
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		ID string `json:"Id"`
	}
	if response.Status != 201 || json.Unmarshal(response.Body, &created) != nil || created.ID == "" {
		t.Fatalf("创建临时容器失败: %d %s", response.Status, response.Body)
	}
	t.Cleanup(func() {
		result, err := transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodDelete, Path: "/containers/" + created.ID, Query: url.Values{"force": {"1"}, "v": {"1"}}, Timeout: 15 * time.Second, MaxBytes: 64 * 1024})
		if err != nil || result.Status != 204 {
			t.Errorf("清理临时容器失败: %d %v", result.Status, err)
		}
	})
	response, err = transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodPost, Path: "/containers/" + created.ID + "/start", Timeout: 10 * time.Second, MaxBytes: 64 * 1024})
	if err != nil || response.Status != 204 {
		t.Fatalf("启动临时容器失败: %d %v", response.Status, err)
	}
	runner := createContainerExecRunner(socket, created.ID)
	if installPrograms {
		installed := liveDockerCommand(t, runner, 3*time.Minute, []string{"/bin/sh", "-c", "export DEBIAN_FRONTEND=noninteractive; { apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update && apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends vim-tiny less tmux busybox; } >/tmp/elysian-apt.log 2>&1 || { cat /tmp/elysian-apt.log; exit 1; }; dpkg-query -W vim-tiny less tmux busybox"})
		t.Logf("临时容器官方程序版本:\n%s", installed)
		disconnect, _ := json.Marshal(map[string]any{"Container": created.ID, "Force": false})
		response, err := transport.Request(context.Background(), seam.EngineRequest{Method: http.MethodPost, Path: "/networks/bridge/disconnect", Body: disconnect, Timeout: 10 * time.Second, MaxBytes: 64 * 1024})
		if err != nil || response.Status != 200 {
			t.Fatalf("安装后断开临时容器网络失败: %d %v %s", response.Status, err, response.Body)
		}
	}
	return runner
}

func liveDockerCommand(t *testing.T, runner execRunner, timeout time.Duration, argv []string) string {
	t.Helper()
	// 无交互命令也使用 TTY，直接读取原始输出，避免 Docker 非 TTY 多路复用帧。
	session := runner.Run(argv, true, nil)
	defer session.Close()
	timer := time.AfterFunc(timeout, session.Close)
	defer timer.Stop()
	result, err := readStdoutText(io.LimitReader(session, 512*1024))
	if err != nil {
		t.Fatalf("临时容器命令读取失败: %v\n%s", err, result)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if code, finished := session.exitStatus(); finished {
			if code != 0 {
				t.Fatalf("临时容器命令失败: exit=%d\n%s", code, result)
			}
			return result
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("临时容器命令未确认退出（可能超时）:\n%s", result)
	return ""
}

func TestLiveDockerRawTerminal(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_EXEC") != "1" {
		t.Skip("需要显式启用真实 Docker 终端联调")
	}
	runner := liveDockerTerminalContainer(t, false)
	if kind := probeShell(runner); kind != shellBash {
		t.Fatalf("bash 探测失败: %s", kind)
	}

	for _, kind := range []shellKind{shellBash, shellSh} {
		t.Run(string(kind), func(t *testing.T) {
			p, err := createExecPty(runner, shellSpecFor(kind))
			if err != nil {
				t.Fatal(err)
			}
			defer p.Kill()
			output := &liveTerminalOutput{}
			go func() { _, _ = io.Copy(output, p.Stdout()) }()
			send := func(input string) {
				t.Helper()
				if _, err := p.Write([]byte(input)); err != nil {
					t.Fatal(err)
				}
			}
			expect := func(text string) {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					if strings.Contains(output.String(), text) {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("未收到 %q; 输出=%q", text, output.String())
			}
			if err = p.Resize(132, 44); err != nil {
				t.Fatal(err)
			}
			send("printf '\\033[31mRAW-中文\\033[0m\\n'; stty size\r")
			expect("\x1b[31mRAW-中文\x1b[0m\r\n")
			expect("44 132\r\n")
			if kind == shellBash {
				send("printf 'EDIT-yes\\n'xxx\x7f\x7f\x7f\r")
				expect("EDIT-yes\r\n")
				send("read -rs -p 'PASSWORD-MARK:' value; printf '\\nSECRET-LEN:%s\\n' \"${#value}\"\r")
				deadline := time.Now().Add(5 * time.Second)
				for !strings.HasSuffix(output.String(), "PASSWORD-MARK:") {
					if time.Now().After(deadline) {
						t.Fatalf("密码提示未就绪: %q", output.String())
					}
					time.Sleep(10 * time.Millisecond)
				}
				secret := "unique-private-input-197"
				send(secret + "\r")
				expect("SECRET-LEN:24\r\n")
				if strings.Contains(output.String(), secret) {
					t.Fatal("密码输入被回显")
				}
				send("python3 -c 'import curses; curses.wrapper(lambda s: (s.addstr(0,0,\"CURSES-OK\"),s.refresh(),curses.napms(30)))'; printf 'AFTER-TUI\\n'\r")
				expect("\x1b[?1049h")
				expect("\x1b[?1049l")
				expect("AFTER-TUI\r\n")
			}
			send("sleep 30\r")
			expect("sleep 30\r\n")
			send("\x03printf 'AFTER-C\\n'\r")
			expect("AFTER-C\r\n")
			send("sleep 300\r")
			expect("sleep 300\r\n")
			concrete := p.(*execPty)
			concrete.mu.Lock()
			pid := concrete.pid
			concrete.mu.Unlock()
			if err = p.Kill(); err != nil {
				t.Fatal(err)
			}
			check := runner.Run([]string{"/bin/sh", "-c", `if kill -0 "$1" 2>/dev/null; then printf ALIVE; else printf GONE; fi`, "--", pid}, false, nil)
			result, err := readStdoutText(check)
			check.Close()
			if err != nil || !strings.Contains(result, "GONE") {
				t.Fatalf("终端 shell 仍存活: pid=%s output=%q err=%v", pid, result, err)
			}
		})
	}
}

func TestLiveDockerTerminalHistory(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_EXEC") != "1" {
		t.Skip("需要显式启用真实 Docker 终端联调")
	}
	runner := liveDockerTerminalContainer(t, false)
	for _, name := range []string{"missing", "existing"} {
		t.Run(name, func(t *testing.T) {
			home := "/tmp/elysian-history-" + name
			liveDockerCommand(t, runner, 5*time.Second, []string{"/bin/sh", "-c", `mkdir -p "$1"; if [ "$2" = existing ]; then printf 'pre-existing-history-must-stay-unchanged\n' > "$1/.bash_history"; fi`, "--", home, name})
			spec := shellSpecFor(shellBash)
			spec.env = append(spec.env, "HOME="+home)
			p, err := createExecPty(runner, spec)
			if err != nil {
				t.Fatal(err)
			}
			defer p.Kill()
			output := &liveTerminalOutput{}
			go func() { _, _ = io.Copy(output, p.Stdout()) }()
			checkpoint := 0
			expect := func(text string) {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					current := output.String()
					if strings.Contains(current[checkpoint:], text) {
						checkpoint = len(current)
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("未收到 %q: %q", text, output.String())
			}
			if _, err := p.Write([]byte("printf 'HISTORY-MEMORY:%s\\n' OK\r")); err != nil {
				t.Fatal(err)
			}
			expect("HISTORY-MEMORY:OK\r\n")
			if _, err := p.Write([]byte("\x1b[A\r")); err != nil {
				t.Fatal(err)
			}
			expect("HISTORY-MEMORY:OK\r\n")
			if _, err := p.Write([]byte("exit\r")); err != nil {
				t.Fatal(err)
			}
			select {
			case code := <-p.Exited():
				if code != 0 {
					t.Fatalf("shell exit=%d", code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("shell 未正常退出")
			}
			written := liveDockerCommand(t, runner, 5*time.Second, []string{"/bin/sh", "-c", `if [ -e "$1/.bash_history" ]; then cat "$1/.bash_history"; else printf MISSING; fi`, "--", home})
			want := "MISSING"
			if name == "existing" {
				want = "pre-existing-history-must-stay-unchanged\r\n"
			}
			if written != want {
				t.Fatalf("容器终端持久化了历史命令: got=%q want=%q", written, want)
			}
		})
	}
}

// 单独显式开启：只向一次性容器的官方 apt 源安装程序，测试完成后删除容器。
func TestLiveDockerTerminalPrograms(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_EXEC_PROGRAMS") != "1" {
		t.Skip("需要显式启用真实 Linux 终端程序联调（临时容器内安装官方包）")
	}
	runner := liveDockerTerminalContainer(t, true)
	for _, program := range []string{"vi", "top", "less", "tmux", "busybox-sh"} {
		t.Run(program, func(t *testing.T) {
			p, err := createExecPty(runner, shellSpecFor(shellBash))
			if err != nil {
				t.Fatal(err)
			}
			defer p.Kill()
			output := &liveTerminalOutput{}
			go func() { _, _ = io.Copy(output, p.Stdout()) }()
			send := func(input string) {
				t.Helper()
				if _, err := p.Write([]byte(input)); err != nil {
					t.Fatal(err)
				}
			}
			expect := func(text string) {
				t.Helper()
				deadline := time.Now().Add(10 * time.Second)
				for time.Now().Before(deadline) {
					if strings.Contains(output.String(), text) {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Fatalf("未收到 %q; 输出=%q", text, output.String())
			}
			resize := func(cols, rows int) {
				t.Helper()
				if err := p.Resize(cols, rows); err != nil {
					t.Fatal(err)
				}
			}
			resize(100, 32)
			send("PS1='LIVE-READY> '; printf 'SHELL-READY\\n'\r")
			expect("SHELL-READY\r\n")
			switch program {
			case "vi":
				send("vi -Nu NONE -i NONE -n /tmp/elysian-live-vi.txt\r")
				expect("\x1b[?1049h")
				expect("[New]")
				send("iVI-PROGRAM-中文-OK\x1b")
				resize(132, 44)
				send(":wq\r")
				expect("\x1b[?1049l")
				if saved := liveDockerCommand(t, runner, 5*time.Second, []string{"cat", "/tmp/elysian-live-vi.txt"}); saved != "VI-PROGRAM-中文-OK\r\n" {
					t.Fatalf("vi 未正确保存实际文件: %q", saved)
				}
				send("printf 'VI-RETURNED\\n'; stty size\r")
				expect("VI-RETURNED\r\n")
				expect("44 132\r\n")
			case "top":
				send("top -d 0.1\r")
				expect("Tasks:")
				expect("load average:")
				resize(132, 44)
				send("q")
				expect("\x1b[?1l")
				send("printf 'TOP-RETURNED\\n'; stty size\r")
				expect("TOP-RETURNED\r\n")
				expect("44 132\r\n")
			case "less":
				send("seq -f 'LESS-LINE-%03g' 1 250 >/tmp/elysian-live-less.txt; less -N /tmp/elysian-live-less.txt\r")
				expect("\x1b[?1049h")
				expect("LESS-LINE-001")
				send("G")
				expect("LESS-LINE-250")
				resize(132, 44)
				send("q")
				expect("\x1b[?1049l")
				send("printf 'LESS-RETURNED\\n'; stty size\r")
				expect("LESS-RETURNED\r\n")
				expect("44 132\r\n")
			case "tmux":
				defer liveDockerCommand(t, runner, 5*time.Second, []string{"/bin/sh", "-c", "tmux -L elysian-live-test kill-server 2>/dev/null || true"})
				send("tmux -L elysian-live-test -f /dev/null new-session -s live\r")
				expect("\x1b[?1049h")
				send("tmux set-option -g status off; printf 'TMUX-PANE-READY\\n'\r")
				expect("TMUX-PANE-READY\r\n")
				resize(132, 44)
				send("sleep 0.1; tmux display-message -p 'PANE-SIZE:#{pane_width}x#{pane_height}'\r")
				expect("PANE-SIZE:132x44\r\n")
				send("exit\r")
				expect("\x1b[?1049l")
				send("printf 'TMUX-RETURNED\\n'; tmux -L elysian-live-test list-sessions 2>/dev/null || printf 'TMUX-SERVER-GONE\\n'; stty size\r")
				expect("TMUX-RETURNED\r\n")
				expect("TMUX-SERVER-GONE\r\n")
				expect("44 132\r\n")
			case "busybox-sh":
				send("/bin/busybox sh -i\r")
				expect("BusyBox v")
				send("printf 'BUSYBOX-SHELL:%s\\n' \"$0\"\r")
				expect("BUSYBOX-SHELL:sh\r\n")
				resize(132, 44)
				send("stty size; printf 'BUSYBOX-RESIZED\\n'\r")
				expect("44 132\r\nBUSYBOX-RESIZED\r\n")
				send("exit\r")
				send("printf 'BUSYBOX-RETURNED\\n'\r")
				expect("BUSYBOX-RETURNED\r\n")
			}
		})
	}
}

type liveTerminalOutput struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (o *liveTerminalOutput) Write(b []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buffer.Write(b)
}
func (o *liveTerminalOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buffer.String()
}
