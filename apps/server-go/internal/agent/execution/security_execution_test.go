package execution

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"elysian/server/internal/agent/execution/config"
)

// realMountRoot 把挂载根解析为不含符号链接的真实路径，
// 避免 macOS 临时目录（/var → /private/var）触发目录事实校验的链接拒绝。
func realMountRoot(t *testing.T, e *Executor) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(e.options.MountRoot)
	if err != nil {
		t.Fatal(err)
	}
	e.options.MountRoot = real
	return real
}

// 停用是紧急切断语义：SetGrantEnabled(false) 只追加 Enabled=false 的新修订，
// 固定修订快照本身仍为启用，因此派发必须按最新修订回查停用状态，
// 禁止停用授权继续挂载业务目录或创建执行容器。
func TestDisabledGrantLatestRevisionBlocksStart(t *testing.T) {
	for _, mode := range []string{"stdio", "script"} {
		t.Run(mode, func(t *testing.T) {
			e, f := newFakeExecutor(t)
			biz := filepath.Join(realMountRoot(t, e), "biz")
			if err := os.Mkdir(biz, 0755); err != nil {
				t.Fatal(err)
			}
			pinned := &config.Grant{ID: "grant-x", Revision: 1, Name: "业务目录授权", Enabled: true, Directories: []config.Directory{{Path: biz, Access: "rw"}}}
			e.options.ResolveGrant = func(id string, revision int) (*config.Grant, error) {
				if id != pinned.ID {
					return nil, errors.New("未知授权")
				}
				copied := *pinned
				if revision == 0 {
					// 管理员已停用：最新修订 Enabled=false。
					copied.Revision, copied.Enabled = 2, false
				}
				return &copied, nil
			}
			var err error
			if mode == "stdio" {
				_, err = e.OpenStdio(context.Background(), StdioRequest{ID: "mcp-disabled", Profile: testProfile(), Grant: pinned, Command: []string{"python3", "server.py"}})
			} else {
				var out bytes.Buffer
				_, err = e.RunScript(context.Background(), ScriptRequest{ID: "script-disabled", Profile: testProfile(), Grant: pinned, ScriptPath: "scripts/main.py", SkillArchive: bytes.NewReader(testTar("scripts/main.py", "pass")), WorkspaceOutput: &out})
			}
			var known *Error
			if !errors.As(err, &known) || known.Code != "execution-grant-disabled" {
				t.Fatalf("err=%v", err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.creates) != 0 || len(f.volumes) != 0 {
				t.Fatalf("停用授权仍创建了容器或卷 creates=%d volumes=%d", len(f.creates), len(f.volumes))
			}
		})
	}
}

// 最新修订保持启用的授权不受回查影响，正常派发不被误伤。
func TestEnabledGrantLatestRevisionStillStarts(t *testing.T) {
	e, f := newFakeExecutor(t)
	biz := filepath.Join(realMountRoot(t, e), "biz")
	if err := os.Mkdir(biz, 0755); err != nil {
		t.Fatal(err)
	}
	pinned := &config.Grant{ID: "grant-x", Revision: 1, Name: "业务目录授权", Enabled: true, Directories: []config.Directory{{Path: biz, Access: "ro"}}}
	e.options.ResolveGrant = func(id string, revision int) (*config.Grant, error) {
		copied := *pinned
		if revision == 0 {
			copied.Revision, copied.Enabled = 2, true
		}
		return &copied, nil
	}
	p, err := e.OpenStdio(context.Background(), StdioRequest{ID: "mcp-enabled", Profile: testProfile(), Grant: pinned, Command: []string{"python3", "server.py"}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err = p.Close(ctx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != 2 || len(f.started) != 1 || len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatalf("正常授权派发与回收异常 creates=%d starts=%d containers=%d volumes=%d", len(f.creates), len(f.started), len(f.labels), len(f.volumes))
	}
}
