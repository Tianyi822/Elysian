package harness

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/workspace"
)

func TestApprovalFileChangesUsePinnedRevision(t *testing.T) {
	ctx := context.Background()
	backend, err := workspace.Open(filepath.Join(t.TempDir(), "workspace"))
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	first, err := backend.PrepareWrite(ctx, "task", 0, "config.txt", strings.NewReader("approved baseline"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = backend.PrepareWrite(ctx, "task", first.Revision, "config.txt", strings.NewReader("later candidate")); err != nil {
		t.Fatal(err)
	}
	m := &Manager{deps: Deps{Workspaces: backend}}
	operation := Operation{TaskID: "task", WorkspaceRevision: first.Revision, Capability: Capability{Name: TaskWorkspaceWrite, Source: "workspace"}, ArgumentsJSON: `{"path":"config.txt","content":"replacement"}`}
	changes, err := m.prepareWorkspaceChanges(ctx, operation)
	if err != nil || len(changes) != 1 {
		t.Fatalf("changes=%+v err=%v", changes, err)
	}
	if changes[0].Before == nil || changes[0].Before.Text == nil || *changes[0].Before.Text != "approved baseline" || *changes[0].After.Text != "replacement" {
		t.Fatalf("preview changed baseline: %+v", changes[0])
	}
	operation.Capability.Name = TaskWorkspaceMove
	operation.ArgumentsJSON = `{"path":"config.txt","target":"renamed.txt"}`
	changes, err = m.prepareWorkspaceChanges(ctx, operation)
	if err != nil || len(changes) != 2 || changes[0].After != nil || changes[1].Before != nil || changes[1].Path != "renamed.txt" || changes[0].Before.Digest != changes[1].After.Digest {
		t.Fatalf("move preview=%+v err=%v", changes, err)
	}
}

func TestApprovalFileContentIsBoundedAndBinarySafe(t *testing.T) {
	for _, body := range []string{strings.Repeat("x", operationPreviewBytes+1), "binary\x00text"} {
		value := previewContent([]byte(body))
		if value.Text != nil || value.Bytes == nil || *value.Bytes != len(body) || value.Digest != contentDigest([]byte(body)) {
			t.Fatal("preview omitted identity or included unsafe text")
		}
	}
	if value := previewContent(nil); value.Text == nil || *value.Text != "" {
		t.Fatal("empty file became missing file")
	}
}

func TestHostPreviewRequiresExactConfirmedContent(t *testing.T) {
	baseline := "confirmed content"
	expected := contentDigest([]byte(baseline))
	args, _ := json.Marshal(map[string]string{"root": "/srv/business", "path": "file.txt", "content": "next", "expected": expected})
	receipt, _ := json.Marshal(map[string]string{"root": "/srv/business", "path": "file.txt", "content": baseline, "version": expected})
	operation := Operation{Capability: Capability{Name: "file_write"}, ArgumentsJSON: string(args)}
	for _, test := range []struct {
		name  string
		call  Call
		shown bool
	}{
		{"confirmed", Call{Tool: "file_read", Status: StateSucceeded, Result: receipt}, true},
		{"failed", Call{Tool: "file_read", Status: StateFailed, Result: receipt}, false},
		{"truncated", Call{Tool: "file_read", Status: StateSucceeded, Result: receipt, Truncated: true}, false},
		{"forged-content", Call{Tool: "file_read", Status: StateSucceeded, Result: json.RawMessage(`{"root":"/srv/business","path":"file.txt","content":"unverified","version":"` + expected + `"}`)}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			changes, err := previewHostFileChanges(operation, []Call{test.call})
			if err != nil || len(changes) != 1 {
				t.Fatalf("changes=%+v err=%v", changes, err)
			}
			if (changes[0].Before.Text != nil) != test.shown {
				t.Fatal("preview used unconfirmed baseline")
			}
			if !test.shown && changes[0].Before.Bytes != nil {
				t.Fatal("unknown size presented as zero")
			}
		})
	}
}
