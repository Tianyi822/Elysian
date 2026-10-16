package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testAgentFiles(t *testing.T) (*AgentFacade, string, *int) {
	t.Helper()
	root := t.TempDir()
	calls := 0
	f, err := NewAgentFacade(Deps{Available: true, Accounts: newFakeSystemAccounts()}, AgentOptions{Roots: []AgentRoot{{Path: root, Writable: true}}, Authorize: func(context.Context) error { calls++; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	return f, root, &calls
}

func agentVersion(t *testing.T, f *AgentFacade, root, path string) string {
	t.Helper()
	value, err := f.Read(context.Background(), root, path)
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)["version"].(string)
}

func TestAgentFilesVersionedMutationsAndOneAuthorization(t *testing.T) {
	f, root, calls := testAgentFiles(t)
	ctx := context.Background()
	if _, err := f.Write(ctx, root, "a.txt", "first", "missing"); err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("authorization count=%d", *calls)
	}
	version := agentVersion(t, f, root, "a.txt")
	if _, err := f.Write(ctx, root, "a.txt", "clobber", "missing"); err == nil {
		t.Fatal("existing file overwritten")
	}
	if _, err := f.Write(ctx, root, "a.txt", "second", version); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Change(ctx, root, "a.txt", "", version, "delete"); err == nil {
		t.Fatal("stale delete accepted")
	}
	version = agentVersion(t, f, root, "a.txt")
	before := *calls
	if _, err := f.Change(ctx, root, "a.txt", "b.txt", version, "copy"); err != nil {
		t.Fatal(err)
	}
	if *calls != before+1 {
		t.Fatalf("copy consumed authorization %d times", *calls-before)
	}
	if _, err := f.Change(ctx, root, "a.txt", "b.txt", version, "copy"); err == nil {
		t.Fatal("copy replaced target")
	}
	if runtime.GOOS == "linux" {
		if _, err := f.Change(ctx, root, "a.txt", "b.txt", version, "move"); err == nil {
			t.Fatal("move replaced target")
		}
		if _, err := f.Change(ctx, root, "a.txt", "c.txt", version, "move"); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(filepath.Join(root, "a.txt")); !os.IsNotExist(err) {
			t.Fatalf("source remains: %v", err)
		}
	}
	if _, err := f.Change(ctx, root, "b.txt", "", version, "delete"); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".elysian-") {
			t.Fatal("staging file leaked")
		}
	}
}

func TestAgentFilesDenyUnsafePathsAndStaleContent(t *testing.T) {
	f, root, _ := testAgentFiles(t)
	ctx := context.Background()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "outside.txt"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, root, "link/outside.txt"); err == nil {
		t.Fatal("followed parent symlink")
	}
	if err := os.Symlink(filepath.Join(outside, "outside.txt"), filepath.Join(root, "linked.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, root, "linked.txt"); err == nil {
		t.Fatal("followed final symlink")
	}
	for _, path := range []string{"../outside.txt", "/etc/passwd", ".env.production", ".ssh/config", "cert.key"} {
		if _, err := f.Write(ctx, root, path, "data", "missing"); err == nil {
			t.Fatalf("accepted forbidden path %s", path)
		}
	}
	if _, err := f.Write(ctx, root, "source.txt", "old", "missing"); err != nil {
		t.Fatal(err)
	}
	version := agentVersion(t, f, root, "source.txt")
	if err := os.Link(filepath.Join(root, "source.txt"), filepath.Join(root, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, root, "hard.txt"); err == nil {
		t.Fatal("read hardlink")
	}
	os.Remove(filepath.Join(root, "hard.txt"))
	if err := os.WriteFile(filepath.Join(root, "source.txt"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(ctx, root, "source.txt", "bad", version); err == nil {
		t.Fatal("stale replacement accepted")
	}
	if _, err := f.Change(ctx, root, "source.txt", "../escape.txt", agentVersion(t, f, root, "source.txt"), "copy"); err == nil {
		t.Fatal("cross-root copy accepted")
	}
}

func TestAgentFilesMissingAuthorityAndSensitiveRootFailClosed(t *testing.T) {
	if _, err := NewAgentFacade(Deps{}, AgentOptions{Roots: []AgentRoot{{Path: "/etc"}}}); err == nil {
		t.Fatal("system root accepted")
	}
	f, root, _ := testAgentFiles(t)
	f.authorize = nil
	if _, err := f.List(context.Background(), root, "."); err == nil {
		t.Fatal("missing authority accepted")
	}
	f.authorize = func(context.Context) error { return context.Canceled }
	if _, err := f.Write(context.Background(), root, "denied.txt", "data", "missing"); err == nil {
		t.Fatal("denied operation ran")
	}
	if _, err := os.Stat(filepath.Join(root, "denied.txt")); !os.IsNotExist(err) {
		t.Fatalf("unauthorized write: %v", err)
	}
}

func TestAgentFilesRejectReplacedRootIdentity(t *testing.T) {
	f, root, _ := testAgentFiles(t)
	if _, err := f.Write(context.Background(), root, "existing.txt", "original", "missing"); err != nil {
		t.Fatal(err)
	}
	moved := root + "-moved"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "existing.txt"), []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(context.Background(), root, "existing.txt"); err == nil {
		t.Fatal("read accepted a different root inode")
	}
	if _, err := f.Write(context.Background(), root, "new.txt", "data", "missing"); err == nil {
		t.Fatal("write accepted a different root inode")
	}
	if _, err := f.List(context.Background(), root, "."); err == nil {
		t.Fatal("list accepted a different root inode")
	}
}

func TestAgentFilesCopyHasPrivateModeAndCancelledWritesDoNotPublish(t *testing.T) {
	f, root, _ := testAgentFiles(t)
	if err := os.WriteFile(filepath.Join(root, "source.txt"), []byte("contents"), 0644); err != nil {
		t.Fatal(err)
	}
	version := agentVersion(t, f, root, "source.txt")
	if _, err := f.Change(context.Background(), root, "source.txt", "private.txt", version, "copy"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "private.txt"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("copy mode was not private: %#v %v", info, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	f.authorize = func(context.Context) error { cancel(); return nil }
	if _, err := f.Write(ctx, root, "cancelled.txt", "unpublished", "missing"); err == nil {
		t.Fatal("cancelled write succeeded")
	}
	if _, err := os.Stat(filepath.Join(root, "cancelled.txt")); !os.IsNotExist(err) {
		t.Fatal("cancelled write published content", err)
	}
}

func TestAgentFilesRejectProtectedPathsUnderGrantedAncestor(t *testing.T) {
	f, _, _ := testAgentFiles(t)
	root := "/var/lib"
	f.roots[root] = agentRootGrant{AgentRoot: AgentRoot{Path: root, Writable: true}}
	for _, directory := range []string{"elysian", "docker", "containerd", "apt", "dpkg", "systemd"} {
		t.Run(directory, func(t *testing.T) {
			path := directory + "/agent-test.txt"
			for operation, run := range map[string]func() error{
				"read":  func() error { _, err := f.Read(context.Background(), root, path); return err },
				"write": func() error { _, err := f.Write(context.Background(), root, path, "blocked", "missing"); return err },
				"list":  func() error { _, err := f.List(context.Background(), root, directory); return err },
				"delete": func() error {
					_, err := f.Change(context.Background(), root, path, "", strings.Repeat("0", 64), "delete")
					return err
				},
			} {
				if err := run(); !errors.Is(err, errAgentProtectedPath) {
					t.Errorf("%s did not reject protected path before IO: %v", operation, err)
				}
			}
		})
	}
	for _, path := range []string{"/lib", "/lib64", "/var/run", "/var/log", "/var/cache", "/var/spool"} {
		if !forbiddenAgentRoot(path) || !forbiddenAgentRoot(path+"/child") {
			t.Errorf("protected root accepted: %s", path)
		}
	}
	if forbiddenAgentRoot("/var/www/project") {
		t.Fatal("ordinary website business directory rejected")
	}
}

func TestAgentFilesCopyMoveRejectProtectedTargetsAndListHidesThem(t *testing.T) {
	sourceRoot, err := os.MkdirTemp("/var/lib", "elysian-agent-boundary-")
	if err != nil {
		t.Skip("requires writable /var/lib for an isolated source fixture")
	}
	t.Cleanup(func() { _ = os.RemoveAll(sourceRoot) })
	sourcePath := filepath.Join(sourceRoot, "source.txt")
	if err := os.WriteFile(sourcePath, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := NewAgentFacade(Deps{Available: true, Accounts: newFakeSystemAccounts()}, AgentOptions{
		Roots: []AgentRoot{{Path: "/var/lib", Writable: true}}, Authorize: func(context.Context) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Base(sourceRoot) + "/source.txt"
	version := agentVersion(t, f, "/var/lib", path)
	for _, directory := range []string{"elysian", "docker", "containerd"} {
		for _, action := range []string{"copy", "move"} {
			if _, err := f.Change(context.Background(), "/var/lib", path, directory+"/agent-test.txt", version, action); !errors.Is(err, errAgentProtectedPath) {
				t.Errorf("%s target %s did not reject protected path: %v", action, directory, err)
			}
		}
	}
	data, err := os.ReadFile(sourcePath)
	if err != nil || string(data) != "original" {
		t.Fatalf("rejected move changed source: %q %v", data, err)
	}
	value, err := f.List(context.Background(), "/var/lib", ".")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range value.(map[string]any)["entries"].([]map[string]any) {
		if agentProtectedPath(filepath.Join("/var/lib", row["name"].(string))) {
			t.Errorf("list exposed protected entry: %v", row)
		}
	}
}
