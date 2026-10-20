package files

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type testRootAuthorizationKey struct{}

func trustedAgentRoot(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("trusted ancestor fixture requires the Linux root test container")
	}
	root, err := os.MkdirTemp("/var/lib", "elysian-agent-dynamic-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}

func dynamicAgentFiles(t *testing.T) *AgentFacade {
	t.Helper()
	f, err := NewAgentFacade(Deps{Available: true, Accounts: newFakeSystemAccounts()}, AgentOptions{
		Authorize: func(ctx context.Context) error {
			if _, ok := ctx.Value(testRootAuthorizationKey{}).(AgentRootAuthorization); !ok {
				return errors.New("missing committed dispatch")
			}
			return nil
		},
		ResolveRoot: func(ctx context.Context, root string, write bool) (AgentRootAuthorization, error) {
			grant, ok := ctx.Value(testRootAuthorizationKey{}).(AgentRootAuthorization)
			if !ok || grant.Path != root || write && !grant.Writable {
				return AgentRootAuthorization{}, errors.New("dispatch has no matching root")
			}
			return grant, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func rootContext(t *testing.T, root string, write bool) context.Context {
	t.Helper()
	grant, err := InspectAgentRoot(AgentRoot{Path: root, Writable: write})
	if err != nil {
		t.Fatal(err)
	}
	return context.WithValue(context.Background(), testRootAuthorizationKey{}, grant)
}

func TestDynamicAgentRootWorksImmediatelyWithoutGlobalGrant(t *testing.T) {
	root := trustedAgentRoot(t)
	f := dynamicAgentFiles(t)
	if !f.Available() || !f.DynamicRoots() || len(f.Roots()) != 0 {
		t.Fatal("dynamic capability must be available with an empty static root list")
	}
	if _, err := f.Write(context.Background(), root, "record.txt", "denied", "missing"); err == nil {
		t.Fatal("missing dispatch authority allowed a write")
	}
	ctx := rootContext(t, root, true)
	if _, err := f.Write(ctx, root, "record.txt", "approved", "missing"); err != nil {
		t.Fatal(err)
	}
	read, err := f.Read(ctx, root, "record.txt")
	if err != nil || read.(map[string]any)["content"] != "approved" {
		t.Fatalf("approved root did not become immediately usable: %v %v", read, err)
	}
	version := read.(map[string]any)["version"].(string)
	if _, err := f.Change(ctx, root, "record.txt", "copy.txt", version, "copy"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(rootContext(t, root, false), root, "read-only.txt", "denied", "missing"); err == nil {
		t.Fatal("read-only dispatch allowed a write")
	}
	if _, err := f.Read(context.Background(), root, "record.txt"); err == nil {
		t.Fatal("an earlier dispatch leaked authority to a later call")
	}
	if len(f.Roots()) != 0 {
		t.Fatal("per-operation root was added to the global root list")
	}
}

func TestDynamicAgentRootDoesNotFallbackOrAcceptResolverMismatch(t *testing.T) {
	f, root, _ := testAgentFiles(t)
	grant, err := f.ConfiguredRoot(root, true)
	if err != nil {
		t.Fatal(err)
	}
	f.resolveRoot = func(context.Context, string, bool) (AgentRootAuthorization, error) {
		return AgentRootAuthorization{}, errors.New("revoked")
	}
	if _, err := f.Write(context.Background(), root, "denied.txt", "bad", "missing"); err == nil {
		t.Fatal("resolver denial fell back to a startup grant")
	}
	for _, invalid := range []AgentRootAuthorization{
		{Path: root + "-different", Writable: true, Device: grant.Device, Inode: grant.Inode},
		{Path: root, Writable: false, Device: grant.Device, Inode: grant.Inode},
		{Path: root, Writable: true, Device: grant.Device},
	} {
		f.resolveRoot = func(context.Context, string, bool) (AgentRootAuthorization, error) { return invalid, nil }
		if _, err := f.Write(context.Background(), root, "denied.txt", "bad", "missing"); err == nil {
			t.Fatalf("invalid resolver fact accepted: %+v", invalid)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "denied.txt")); !os.IsNotExist(err) {
		t.Fatalf("rejected dispatch modified disk: %v", err)
	}
	f.resolveRoot = func(context.Context, string, bool) (AgentRootAuthorization, error) { return grant, nil }
	f.authorize = nil
	if f.Available() {
		t.Fatal("a root resolver alone must not replace the dispatch authority")
	}
}

func TestDynamicAgentRootRejectsReplacementAndPreservesPathChecks(t *testing.T) {
	root := trustedAgentRoot(t)
	f := dynamicAgentFiles(t)
	ctx := rootContext(t, root, true)
	if _, err := f.Write(ctx, root, "source.txt", "original", "missing"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../escape.txt", ".env", "private.key"} {
		if _, err := f.Write(ctx, root, path, "bad", "missing"); err == nil {
			t.Fatalf("unsafe path accepted: %s", path)
		}
	}
	if err := os.Symlink("source.txt", filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, root, "link.txt"); err == nil {
		t.Fatal("dynamic dispatch followed a symlink")
	}
	if err := os.Link(filepath.Join(root, "source.txt"), filepath.Join(root, "hard.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Read(ctx, root, "hard.txt"); err == nil {
		t.Fatal("dynamic dispatch accepted a hard link")
	}
	moved := root + "-old"
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(moved) })
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(ctx, root, "replacement.txt", "bad", "missing"); err == nil {
		t.Fatal("persisted authorization accepted a replaced root inode")
	}
	if _, err := f.List(ctx, root, "."); err == nil {
		t.Fatal("persisted authorization listed a replaced root inode")
	}
}

func TestDynamicAgentRootConcurrentContextsStayIsolated(t *testing.T) {
	roots := []string{trustedAgentRoot(t), trustedAgentRoot(t)}
	f := dynamicAgentFiles(t)
	contexts := []context.Context{rootContext(t, roots[0], true), rootContext(t, roots[1], true)}
	var wg sync.WaitGroup
	for i := range roots {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, err := f.Write(contexts[i], roots[i], "own.txt", roots[i], "missing"); err != nil {
				t.Error(err)
			}
			if _, err := f.Write(contexts[i], roots[1-i], "other.txt", "bad", "missing"); err == nil {
				t.Error("cross-session root access accepted")
			}
		}(i)
	}
	wg.Wait()
	for _, root := range roots {
		data, err := os.ReadFile(filepath.Join(root, "own.txt"))
		if err != nil || string(data) != root {
			t.Fatalf("wrong per-operation root: %q %v", data, err)
		}
		if _, err := os.Stat(filepath.Join(root, "other.txt")); !os.IsNotExist(err) {
			t.Fatalf("cross-session file exists: %v", err)
		}
	}
}

func TestInspectAgentRootRejectsUntrustedAncestorsAndProtectedPaths(t *testing.T) {
	root := trustedAgentRoot(t)
	child := filepath.Join(root, "business")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	grant, err := InspectAgentRoot(AgentRoot{Path: child})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectAgentRoot(AgentRoot{Path: child}); err == nil || !strings.Contains(err.Error(), "祖先") {
		t.Fatalf("writable ancestor accepted: %v", err)
	}
	f := dynamicAgentFiles(t)
	ctx := context.WithValue(context.Background(), testRootAuthorizationKey{}, grant)
	if _, err := f.List(ctx, child, "."); err == nil {
		t.Fatal("ancestor made writable after approval was accepted at dispatch")
	}
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(child, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{link, "/etc", "/var/lib/elysian", "/var/lib/docker", child + "/../business"} {
		if _, err := InspectAgentRoot(AgentRoot{Path: path}); err == nil {
			t.Errorf("unsafe root inspected: %s", path)
		}
	}
}
