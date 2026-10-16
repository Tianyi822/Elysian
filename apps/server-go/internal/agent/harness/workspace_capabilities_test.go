package harness

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"elysian/server/internal/agent/harness/workspace"
)

func TestTaskWorkspaceCapabilitiesUseImmutableRevisions(t *testing.T) {
	backend, err := workspace.Open(filepath.Join(t.TempDir(), "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	ext := &Extensions{Workspaces: backend}

	write := Operation{TaskID: "task", WorkspaceRevision: 0, Capability: Capability{Name: TaskWorkspaceWrite, Source: "workspace"}, ArgumentsJSON: `{"path":"notes.txt","content":"hello"}`}
	result, err := ext.executeTaskWorkspace(context.Background(), write)
	if err != nil || result.Workspace == nil {
		t.Fatalf("write: result=%+v err=%v", result, err)
	}
	if result.Workspace.BaseRevision != 0 || result.Workspace.Revision != 1 {
		t.Fatalf("unexpected revision: %+v", *result.Workspace)
	}

	read := Operation{TaskID: "task", WorkspaceRevision: result.Workspace.Revision, Capability: Capability{Name: TaskWorkspaceRead, Source: "workspace"}, ArgumentsJSON: `{"path":"notes.txt"}`}
	readResult, err := ext.executeTaskWorkspace(context.Background(), read)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(readResult.Value, &value); err != nil || value["text"] != "hello" {
		t.Fatalf("unexpected read value: %s", readResult.Value)
	}
}

func TestTaskWorkspaceArgumentsRejectUnsafePaths(t *testing.T) {
	capability, _ := taskWorkspaceCapability(TaskWorkspaceRead)
	if err := (&Extensions{}).Validate(capability, []byte(`{"path":"ok.txt","extra":true}`)); err == nil {
		t.Fatal("expected unknown workspace argument to be rejected")
	}
	if err := validateTaskWorkspaceArgs(capability, []byte(`{"path":"../../etc/passwd"}`)); err == nil {
		t.Fatal("expected traversal path to be rejected")
	}
	if err := validateTaskWorkspaceArgs(capability, []byte(`{"path":"/etc/passwd"}`)); err == nil {
		t.Fatal("expected absolute path to be rejected")
	}
}

func TestTaskWorkspaceCopyMoveDeletePreserveOldRevisions(t *testing.T) {
	backend, err := workspace.Open(filepath.Join(t.TempDir(), "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	ext := &Extensions{Workspaces: backend}
	call := func(name string, revision int, args string) (*workspace.Version, error) {
		result, err := ext.executeTaskWorkspace(context.Background(), Operation{TaskID: "task", WorkspaceRevision: revision, Capability: Capability{Name: name, Source: "workspace"}, ArgumentsJSON: args})
		return result.Workspace, err
	}
	first, err := call(TaskWorkspaceWrite, 0, `{"path":"a.txt","content":"immutable"}`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := call(TaskWorkspaceCopy, first.Revision, `{"path":"a.txt","target":"b.txt"}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(TaskWorkspaceCopy, second.Revision, `{"path":"a.txt","target":"b.txt"}`); err == nil {
		t.Fatal("copy replaced existing target")
	}
	third, err := call(TaskWorkspaceMove, second.Revision, `{"path":"b.txt","target":"c.txt"}`)
	if err != nil {
		t.Fatal(err)
	}
	fourth, err := call(TaskWorkspaceDelete, third.Revision, `{"path":"a.txt"}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(TaskWorkspaceRead, fourth.Revision, `{"path":"a.txt"}`); err == nil {
		t.Fatal("deleted path remains")
	}
	if _, err := call(TaskWorkspaceRead, first.Revision, `{"path":"a.txt"}`); err != nil {
		t.Fatalf("old revision changed: %v", err)
	}
	if _, err := call(TaskWorkspaceRead, fourth.Revision, `{"path":"c.txt"}`); err != nil {
		t.Fatal(err)
	}
}

func TestBashClaimsCoverTheWholeTaskWorkspace(t *testing.T) {
	claims, _ := operationResourceClaims(CapabilitySnapshot{}, Operation{
		TaskID:        "task",
		Capability:    Capability{Name: TaskBashCommand, Source: BashSource},
		Execution:     &ExecutionPlan{},
		ArgumentsJSON: `{"profileId":"bash","argv":[]}`,
	})
	if len(claims) != 1 || claims[0].Kind != "workspace" || claims[0].Key != "/task" || !claims[0].Subtree || claims[0].Access != "write" {
		t.Fatalf("Bash workspace claim does not cover task subtree: %#v", claims)
	}
}
