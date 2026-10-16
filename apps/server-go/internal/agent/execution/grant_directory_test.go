package execution

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/mcp"
)

func TestGrantDirectoryRejectsUntrustedAncestor(t *testing.T) {
	parent := t.TempDir()
	if err := os.Chmod(parent, 0777); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "business")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := validateGrantDirectory(root); err == nil {
		t.Fatal("writable ancestor accepted")
	}
}

func TestGrantDirectoryScanRejectsSecretsLinksAndSpecialFiles(t *testing.T) {
	for _, kind := range []string{"secret", "symlink", "hardlink", "fifo", "bounded"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			base := filepath.Join(root, "ordinary.txt")
			if err := os.WriteFile(base, []byte("ok"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "secret":
				os.WriteFile(filepath.Join(root, ".env.production"), []byte("token"), 0600)
			case "symlink":
				os.Symlink(base, filepath.Join(root, "link"))
			case "hardlink":
				os.Link(base, filepath.Join(root, "copy"))
			case "fifo":
				makeTestFIFO(t, filepath.Join(root, "pipe"))
			case "bounded":
				for i := 0; i < 4097; i++ {
					file, err := os.CreateTemp(root, "entry-")
					if err != nil {
						t.Fatal(err)
					}
					file.Close()
				}
			}
			file, err := os.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			count := 0
			if err = scanGrantDirectory(int(file.Fd()), 0, &count); err == nil {
				t.Fatal("unsafe directory accepted")
			}
		})
	}
}

func TestMCPUsesDispatchAuthorizationAndPreservesOperationScope(t *testing.T) {
	e, _ := newFakeExecutor(t)
	used := false
	e.options.MCPDispatchID = func(context.Context) string { return "dispatch-identity" }
	e.options.Authorize = func(_ context.Context, id string) error {
		if id != "dispatch-identity" || used {
			return errors.New("denied")
		}
		used = true
		return nil
	}
	ctx := mcp.WithScope(context.Background(), "operation-identity")
	server := mcp.Server{ID: "mcp-server", Revision: 1, Stdio: &mcp.ContainerSpec{Image: testProfile().Image, Command: []string{"python3", "server.py"}}}
	process, err := e.Open(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	if err = process.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err = e.Open(ctx, server); err == nil {
		t.Fatal("backend ticket reused")
	}
	e.options.MCPDispatchID = func(context.Context) string { return "" }
	if _, err = e.Open(ctx, server); err == nil || !strings.Contains(err.Error(), "派发身份") {
		t.Fatalf("missing dispatch err=%v", err)
	}
}
