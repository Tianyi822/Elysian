package skills

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func hexDecode(value string) ([]byte, error) { return hex.DecodeString(value) }

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len()+len(p) > b.limit {
		p = p[:max(0, b.limit-b.Len())]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

func fetchGit(ctx context.Context, rawURL, ref, credential, destination string, limits Limits) (string, error) {
	dir, err := openDirectory(destination, true)
	if err != nil {
		return "", err
	}
	dir.Close()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return "", problem(503, "git-unavailable", "宿主 Git 不可用，无法导入 HTTPS Git 技能")
	}
	env := []string{"PATH=" + os.Getenv("PATH"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_ATTR_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false", "GIT_ALLOW_PROTOCOL=https", "GIT_NO_REPLACE_OBJECTS=1", "GIT_LFS_SKIP_SMUDGE=1", "GIT_CONFIG_COUNT=4", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/dev/null", "GIT_CONFIG_KEY_1=http.followRedirects", "GIT_CONFIG_VALUE_1=false", "GIT_CONFIG_KEY_2=protocol.file.allow", "GIT_CONFIG_VALUE_2=never", "GIT_CONFIG_KEY_3=protocol.ext.allow", "GIT_CONFIG_VALUE_3=never"}
	if credential != "" {
		env[9] = "GIT_CONFIG_COUNT=5"
		env = append(env, "GIT_CONFIG_KEY_4=http.extraHeader", "GIT_CONFIG_VALUE_4=Authorization: Bearer "+credential)
	}
	run := func(args ...string) (string, error) {
		callCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		cmd := exec.CommandContext(callCtx, gitPath, args...)
		cmd.Dir = destination
		cmd.Env = env
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.WaitDelay = time.Second
		cmd.Cancel = func() error {
			if cmd.Process == nil {
				return nil
			}
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		output := &boundedOutput{limit: 256}
		cmd.Stdout = output
		cmd.Stderr = io.Discard
		if err := cmd.Start(); err != nil {
			return "", problem(400, "git-failed", "Git 来源获取失败")
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case err := <-done:
				if ctx.Err() != nil {
					return "", ctx.Err()
				}
				if err != nil {
					return "", problem(400, "git-failed", "Git 来源获取失败，请检查地址、修订和凭据")
				}
				return strings.TrimSpace(output.String()), nil
			case <-ticker.C:
				if treeOverLimit(destination, limits.PackageBytes) {
					cancel()
					<-done
					return "", problem(413, "skill-size-limit", "Git 获取内容超过容量限额")
				}
			}
		}
	}
	if _, err = run("init", "--quiet", "--template="); err != nil {
		return "", err
	}
	if _, err = run("fetch", "--quiet", "--no-tags", "--depth=1", "--no-recurse-submodules", rawURL, ref); err != nil {
		return "", err
	}
	commit, err := run("rev-parse", "--verify", "FETCH_HEAD^{commit}")
	if err != nil {
		return "", err
	}
	if _, err = run("checkout", "--quiet", "--detach", commit); err != nil {
		return "", err
	}
	if treeOverLimit(destination, limits.PackageBytes) {
		return "", problem(413, "skill-size-limit", "Git 获取内容超过容量限额")
	}
	return commit, nil
}
func treeOverLimit(root string, limit int64) bool {
	var total int64
	over := false
	_ = filepath.WalkDir(root, func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			over = true
			return filepath.SkipAll
		}
		if !entry.IsDir() {
			stat, e := entry.Info()
			if e != nil {
				over = true
				return filepath.SkipAll
			}
			total += stat.Size()
			if total > limit {
				over = true
				return filepath.SkipAll
			}
		}
		return nil
	})
	return over
}
