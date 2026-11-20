package harness

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"elysian/server/internal/agent/execution"
)

func workspaceArchiveFile(pattern string) (*os.File, func(), error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close(); _ = os.Remove(f.Name()) }, nil
}

func (e *Extensions) withWorkspaceArchive(ctx context.Context, o Operation, run func(io.Reader, io.Writer) (execution.ScriptResult, error), nonzero Failure) (CapabilityResult, error) {
	var result CapabilityResult
	workRead, workWrite := io.Pipe()
	defer workRead.Close()
	go func() {
		_, err := e.Workspaces.Export(ctx, o.TaskID, o.WorkspaceRevision, workWrite)
		_ = workWrite.CloseWithError(err)
	}()
	out, cleanup, err := workspaceArchiveFile("elysian-workspace-*.tar")
	if err != nil {
		return result, bad("workspace-storage", "无法准备工作区导出")
	}
	defer cleanup()

	value, err := run(workRead, out)
	if err != nil {
		var ee *execution.Error
		if errors.As(err, &ee) {
			result.Unknown = ee.OutcomeUnknown
		}
		return result, err
	}
	if _, err = out.Seek(0, io.SeekStart); err != nil {
		return result, bad("workspace-storage", "无法读取已确认的工作区导出")
	}
	version, err := e.Workspaces.PrepareImport(ctx, o.TaskID, o.WorkspaceRevision, out)
	if err != nil {
		return result, err
	}
	result.Workspace = &version
	result.Value, _ = json.Marshal(value)
	if value.ExitCode != 0 {
		result.BusinessError = &nonzero
	}
	return result, nil
}
