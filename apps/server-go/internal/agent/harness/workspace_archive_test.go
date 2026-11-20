package harness

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness/workspace"
)

func TestWorkspaceArchiveKeepsConfirmedNonzeroResult(t *testing.T) {
	ctx := context.Background()
	store, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	previous, err := store.PrepareWrite(ctx, "task", 0, "file.txt", strings.NewReader("before"))
	if err != nil {
		t.Fatal(err)
	}
	extensions := Extensions{Workspaces: store}
	op := Operation{TaskID: previous.TaskID, WorkspaceRevision: previous.Revision}
	failure := Failure{Code: "bash-exit", Message: "原非零退出回执"}
	result, err := extensions.withWorkspaceArchive(ctx, op, func(in io.Reader, out io.Writer) (execution.ScriptResult, error) {
		input := tar.NewReader(in)
		header, err := input.Next()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(input)
		if err != nil || header.Name != "file.txt" || string(data) != "before" {
			t.Fatalf("导出的不是固定基线版本：%q %q %v", header.Name, data, err)
		}
		if _, err := io.Copy(io.Discard, in); err != nil {
			t.Fatal(err)
		}
		output := tar.NewWriter(out)
		if err := output.WriteHeader(&tar.Header{Name: "file.txt", Mode: 0600, Size: 5}); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(output, "after"); err != nil {
			t.Fatal(err)
		}
		return execution.ScriptResult{ExitCode: 7}, output.Close()
	}, failure)
	if err != nil || result.Workspace == nil || result.Unknown || result.BusinessError == nil || *result.BusinessError != failure {
		t.Fatalf("已确认的非零退出回执不符：%+v %v", result, err)
	}
	if string(result.Value) != `{"containerId":"","exitCode":7,"stdout":"","stderr":"","workspaceBytes":0}` {
		t.Fatalf("执行回执形状改变：%s", result.Value)
	}
	if result.Workspace.TaskID != previous.TaskID || result.Workspace.Revision <= previous.Revision {
		t.Fatalf("导入产物没有追加到同一任务的新版本：%+v", result.Workspace)
	}
	for revision, want := range map[int]string{previous.Revision: "before", result.Workspace.Revision: "after"} {
		data, _, err := store.Read(ctx, op.TaskID, revision, "file.txt")
		if err != nil || string(data) != want {
			t.Fatalf("工作区版本 %d 不符：%q %v", revision, data, err)
		}
	}
}

func TestWorkspaceArchiveDoesNotImportUnknownResult(t *testing.T) {
	ctx := context.Background()
	store, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	extensions := Extensions{Workspaces: store}
	want := &execution.Error{OutcomeUnknown: true, Message: "执行结果未知"}
	var path string
	result, err := extensions.withWorkspaceArchive(ctx, Operation{TaskID: "task"}, func(_ io.Reader, out io.Writer) (execution.ScriptResult, error) {
		path = out.(*os.File).Name()
		return execution.ScriptResult{}, want
	}, Failure{})
	if err != want || !result.Unknown || result.Workspace != nil || result.BusinessError != nil || result.Value != nil {
		t.Fatalf("未知结果投影不符：%+v %v", result, err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("临时归档未清理：%v", err)
	}
}
