package harness

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const operationPreviewBytes = 32 << 10

func previewContent(content []byte) *OperationFileContent {
	size := len(content)
	value := &OperationFileContent{Bytes: &size, Digest: contentDigest(content)}
	if len(content) <= operationPreviewBytes && utf8.Valid(content) && !strings.ContainsRune(string(content), 0) {
		text := string(content)
		value.Text = &text
	}
	return value
}

func (m *Manager) prepareOperationChanges(ctx context.Context, operation Operation) ([]OperationFileChange, error) {
	if operation.Capability.Source == "workspace" {
		return m.prepareWorkspaceChanges(ctx, operation)
	}
	if operation.Capability.Source != "builtin" || operation.Capability.ReadOnly || operation.Capability.Metadata.ResourceType != "filesystem" {
		return nil, nil
	}
	// Host previews reuse confirmed tool receipts, never a new host read before
	// dispatch. A matching content digest is required to show a prior baseline.
	reads, err := readDocuments[Call](ctx, m.store.db, `SELECT c.document FROM calls c JOIN operations o ON o.id=json_extract(c.document,'$.operationId') WHERE c.run_id=? AND c.state='succeeded' AND json_extract(c.document,'$.tool')='file_read' AND json_extract(o.document,'$.capability.source')='builtin' ORDER BY c.rowid DESC LIMIT 64`, operation.RunID)
	if err != nil {
		return nil, storageFailure(err)
	}
	return previewHostFileChanges(operation, reads)
}

func previewHostFileChanges(operation Operation, reads []Call) ([]OperationFileChange, error) {
	var args struct{ Root, Path, Target, Content, Expected string }
	if err := json.Unmarshal([]byte(operation.ArgumentsJSON), &args); err != nil {
		return nil, err
	}
	var before *OperationFileContent
	if args.Expected != "missing" {
		before = &OperationFileContent{Digest: args.Expected}
		for _, call := range reads {
			var receipt struct{ Root, Path, Content, Version string }
			if call.Tool != "file_read" || call.Status != StateSucceeded || call.Truncated || json.Unmarshal(call.Result, &receipt) != nil {
				continue
			}
			if receipt.Root == args.Root && receipt.Path == args.Path && receipt.Version == args.Expected && contentDigest([]byte(receipt.Content)) == args.Expected {
				before = previewContent([]byte(receipt.Content))
				break
			}
		}
	}
	path, target := filepath.Join(args.Root, args.Path), filepath.Join(args.Root, args.Target)
	switch operation.Capability.Name {
	case "file_write":
		return []OperationFileChange{{Path: path, Before: before, After: previewContent([]byte(args.Content))}}, nil
	case "file_delete":
		return []OperationFileChange{{Path: path, Before: before}}, nil
	case "file_copy":
		return []OperationFileChange{{Path: target, After: before}}, nil
	case "file_move":
		return []OperationFileChange{{Path: path, Before: before}, {Path: target, After: before}}, nil
	}
	return nil, nil
}

// Approval previews read only the operation's immutable workspace revision.
// They never guess a baseline from a mutable host path or a later version.
func (m *Manager) prepareWorkspaceChanges(ctx context.Context, operation Operation) ([]OperationFileChange, error) {
	if operation.Capability.Source != "workspace" || operation.Capability.ReadOnly || m.deps.Workspaces == nil {
		return nil, nil
	}
	var args struct {
		Path    string `json:"path"`
		Target  string `json:"target"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(operation.ArgumentsJSON), &args); err != nil {
		return nil, bad("invalid-arguments", "工作区文件预览参数无效")
	}
	view, err := m.deps.Workspaces.List(ctx, operation.TaskID, operation.WorkspaceRevision)
	if err != nil {
		return nil, err
	}
	var before *OperationFileContent
	for _, file := range view.Files {
		if file.Path != args.Path {
			continue
		}
		size := int(file.Size)
		before = &OperationFileContent{Bytes: &size, Digest: file.Digest}
		if file.Size <= operationPreviewBytes {
			body, _, err := m.deps.Workspaces.ReadLimited(ctx, operation.TaskID, operation.WorkspaceRevision, file.Path, operationPreviewBytes)
			if err != nil {
				return nil, err
			}
			before = previewContent(body)
		}
		break
	}
	switch operation.Capability.Name {
	case TaskWorkspaceWrite:
		return []OperationFileChange{{Path: args.Path, Before: before, After: previewContent([]byte(args.Content))}}, nil
	case TaskWorkspaceDelete:
		return []OperationFileChange{{Path: args.Path, Before: before}}, nil
	case TaskWorkspaceCopy:
		return []OperationFileChange{{Path: args.Target, After: before}}, nil
	case TaskWorkspaceMove:
		return []OperationFileChange{{Path: args.Path, Before: before}, {Path: args.Target, After: before}}, nil
	}
	return nil, nil
}
