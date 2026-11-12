package terminals

import (
	"bytes"
	"context"
	"elysian/server/internal/seam"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPtyEnvironmentUsesNativeTerminalAndNoPanelSecrets(t *testing.T) {
	t.Setenv("ELYSIAN_AUTH_PASSWORD", "secret")
	env := buildPtyEnv("/root", nil)
	if env["TERM"] != "xterm-256color" || env["HOME"] != "/root" {
		t.Fatalf("env: %v", env)
	}
	if env["HISTFILE"] != "/dev/null" || buildPtyEnv("/root", map[string]string{"HISTFILE": "/tmp/history"})["HISTFILE"] != "/dev/null" {
		t.Fatal("terminal commands must not be persisted to a history file")
	}
	for _, key := range []string{"PAGER", "GIT_PAGER", "PS1", "PROMPT_COMMAND", "ELYSIAN_AUTH_PASSWORD"} {
		if _, ok := env[key]; ok {
			t.Fatalf("forced or leaked %s", key)
		}
	}
	if got := strings.Join(envPairs(map[string]string{"B": "2", "A": "1"}), "|"); got != "A=1|B=2" {
		t.Fatal(got)
	}
}
func TestIdentityPresent(t *testing.T) {
	id := resolveHostIdentity()
	if id.User == "" || id.HostLabel == "" || id.HomeDir == "" {
		t.Fatalf("identity: %+v", id)
	}
}
func realPty(t *testing.T) seam.PtyProcess {
	t.Helper()
	return realPtyAtHome(t, t.TempDir())
}
func realPtyAtHome(t *testing.T, home string) seam.PtyProcess {
	t.Helper()
	if _, err := os.Stat("/proc"); err != nil {
		t.Skip("requires Linux procfs")
	}
	p, err := spawnPtyShell(context.Background(), seam.ShellSessionSpec{Env: buildPtyEnv(home, nil)}, seam.TerminalIdentity{HomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Kill() })
	_, _ = p.Write([]byte("PS1='ELY_''TEST> '\r"))
	readThrough(t, p, "ELY_TEST> ")
	return p
}

func TestNativePtyKeepsMemoryHistoryWithoutDiskPersistence(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "new-history-file"
		if existing {
			name = "existing-history-file"
		}
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			historyPath := filepath.Join(home, ".bash_history")
			original := []byte("pre-existing-history-must-stay-unchanged\n")
			if existing {
				if err := os.WriteFile(historyPath, original, 0600); err != nil {
					t.Fatal(err)
				}
			}
			p := realPtyAtHome(t, home)
			_, _ = p.Write([]byte("printf '__MEMORY_%s__\\n' HISTORY\r"))
			readCommand(t, p, "__MEMORY_HISTORY__")
			// Native readline's up-arrow replays the last command from memory.
			_, _ = p.Write([]byte("\x1b[A\r"))
			readCommand(t, p, "__MEMORY_HISTORY__")
			_, _ = p.Write([]byte("exit\r"))
			select {
			case code := <-p.Exited():
				if code != 0 {
					t.Fatalf("exit=%d", code)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("exit timed out")
			}
			written, err := os.ReadFile(historyPath)
			if existing {
				if err != nil || !bytes.Equal(written, original) {
					t.Fatalf("existing history changed: %q %v", written, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("terminal created a history file: %q %v", written, err)
			}
		})
	}
}
func readThrough(t *testing.T, p seam.PtyProcess, needle string) string {
	t.Helper()
	return readOutput(t, p, func(text string) bool { return strings.Contains(text, needle) }, needle)
}
func readCommand(t *testing.T, p seam.PtyProcess, marker string) string {
	t.Helper()
	return readOutput(t, p, func(text string) bool {
		i := strings.LastIndex(text, marker)
		return i >= 0 && strings.Contains(text[i+len(marker):], "ELY_TEST> ")
	}, marker+" then prompt")
}
func readOutput(t *testing.T, p seam.PtyProcess, match func(string) bool, description string) string {
	t.Helper()
	type result struct {
		data string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		var b bytes.Buffer
		buf := make([]byte, 4096)
		for {
			n, err := p.Stdout().Read(buf)
			b.Write(buf[:n])
			if match(b.String()) || err != nil {
				done <- result{b.String(), err}
				return
			}
		}
	}()
	select {
	case got := <-done:
		if !match(got.data) {
			t.Fatalf("missing %s, output=%q err=%v", description, got.data, got.err)
		}
		return got.data
	case <-time.After(5 * time.Second):
		_ = p.Kill()
		got := <-done
		t.Fatalf("waiting for %s, output=%q", description, got.data)
	}
	return ""
}
func TestNativePtyResizeEditingAndExit(t *testing.T) {
	p := realPty(t)
	if err := p.Resize(123, 41); err != nil {
		t.Fatal(err)
	}
	_, _ = p.Write([]byte("printf '__TERM:%s__\\n' \"$TERM\"; stty size\r"))
	output := readCommand(t, p, "__TERM:xterm-256color__")
	if !strings.Contains(output, "41 123") {
		t.Fatalf("size missing: %q", output)
	}
	if !strings.Contains(output, "__TERM:xterm-256color__") {
		t.Fatalf("native TERM missing: %q", output)
	}
	// Left-arrow is interpreted by shell readline, not by the application.
	_, _ = p.Write([]byte("printf '__EDIT:%s__\\n' ax\x1b[D\x7fo\r"))
	edited := readCommand(t, p, "__EDIT:ox__")
	if !strings.Contains(edited, "__EDIT:ox__") {
		t.Fatalf("native edit: %q", edited)
	}
	_, _ = p.Write([]byte("exit 7\r"))
	select {
	case code := <-p.Exited():
		if code != 7 {
			t.Fatalf("exit=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("exit timed out")
	}
}
func procHasSleep300() bool {
	entries, _ := os.ReadDir("/proc")
	for _, entry := range entries {
		data, _ := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		fields := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
		if len(fields) >= 2 && fields[0] == "sleep" && fields[1] == "300" {
			return true
		}
	}
	return false
}
func TestDisconnectKillsForegroundJobAndIsIdempotent(t *testing.T) {
	p := realPty(t)
	// Drain output so shell shutdown cannot block on the master buffer.
	go func() { _, _ = io.Copy(io.Discard, p.Stdout()) }()
	_, _ = p.Write([]byte("sleep 300\r"))
	waitFor(t, procHasSleep300, "foreground child not started")
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !procHasSleep300() }, "foreground child survived disconnect")
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
}

func TestNativePtyUnicodePasswordInterruptAndJobControl(t *testing.T) {
	p := realPty(t)
	_, _ = p.Write([]byte("printf '__UNICODE:%s__\\n' '中文😀'\r"))
	unicodeOutput := readCommand(t, p, "__UNICODE:中文😀__")
	if !strings.Contains(unicodeOutput, "__UNICODE:中文😀__") {
		t.Fatalf("unicode: %q", unicodeOutput)
	}
	_, _ = p.Write([]byte("IFS= read -r -s -p 'PASSWORD_''READY' secret; printf '__SECRET_LENGTH:%s__\\n' \"${#secret}\"\r"))
	readThrough(t, p, "PASSWORD_READY")
	_, _ = p.Write([]byte("SENSITIVE_INPUT\r"))
	output := readCommand(t, p, "__SECRET_LENGTH:15__")
	if !strings.Contains(output, "__SECRET_LENGTH:15__") {
		t.Fatalf("password length: %q", output)
	}
	if strings.Contains(output, "SENSITIVE_INPUT") {
		t.Fatalf("password echoed: %q", output)
	}
	_, _ = p.Write([]byte("sleep 300\r"))
	waitFor(t, procHasSleep300, "sleep did not start")
	_, _ = p.Write([]byte{3})
	readThrough(t, p, "ELY_TEST> ")
	_, _ = p.Write([]byte("printf '__INTERRUPT_%s__\\n' OK\r"))
	readCommand(t, p, "__INTERRUPT_OK__")
	waitFor(t, func() bool { return !procHasSleep300() }, "Ctrl+C did not stop sleep")
	_, _ = p.Write([]byte("sleep 300\r"))
	waitFor(t, procHasSleep300, "second sleep did not start")
	_, _ = p.Write([]byte{26})
	output = readThrough(t, p, "ELY_TEST> ")
	if !strings.Contains(output, "Stopped") {
		t.Fatalf("job not stopped: %q", output)
	}
	if !strings.Contains(output, "sleep 300") {
		t.Fatalf("job control output: %q", output)
	}
	_, _ = p.Write([]byte("kill -KILL %1; printf '__JOB_%s__\\n' DONE\r"))
	readCommand(t, p, "__JOB_DONE__")
	waitFor(t, func() bool { return !procHasSleep300() }, "stopped job not cleaned")
	_, _ = p.Write([]byte{4})
	select {
	case code := <-p.Exited():
		if code != 0 {
			t.Fatalf("Ctrl+D exit %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl+D failed")
	}
}

func TestNativePtyCursesAlternateScreenAndResize(t *testing.T) {
	p := realPty(t)
	home := p.(*hostPty).cmd.Dir
	script := `import curses

def main(screen):
    screen.addstr(0, 0, "CURSES_READY")
    screen.refresh()
    while screen.getch() != ord("q"):
        pass

curses.wrapper(main)
`
	if err := os.WriteFile(home+"/curses-smoke.py", []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	_, _ = p.Write([]byte("python3 \"$HOME/curses-smoke.py\"\r"))
	output := readThrough(t, p, "CURSES_READY")
	if !strings.Contains(output, "\x1b[?1049h") {
		t.Fatalf("curses did not enter alternate screen: %q", output)
	}
	if err := p.Resize(80, 24); err != nil {
		t.Fatal(err)
	}
	_, _ = p.Write([]byte("q"))
	alternateExit := readThrough(t, p, "ELY_TEST> ")
	_, _ = p.Write([]byte("stty size; printf '__CURSES_%s__\\n' DONE\r"))
	output = readCommand(t, p, "__CURSES_DONE__")
	if !strings.Contains(alternateExit, "\x1b[?1049l") || !strings.Contains(output, "24 80") {
		t.Fatalf("alternate screen/resize exit: %q", output)
	}
}
