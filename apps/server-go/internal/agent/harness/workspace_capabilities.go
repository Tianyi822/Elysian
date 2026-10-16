package harness

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/workspace"
)

// Task workspace capabilities are deliberately separate from the Docker
// bridge. They operate on the immutable workspace revision attached to the
// current Agent task and never expose a host filesystem path.
const (
	TaskWorkspaceList   = "task_workspace_list"
	TaskWorkspaceRead   = "task_workspace_read"
	TaskWorkspaceWrite  = "task_workspace_write"
	TaskWorkspaceCopy   = "task_workspace_copy"
	TaskWorkspaceMove   = "task_workspace_move"
	TaskWorkspaceDelete = "task_workspace_delete"
)

func taskWorkspaceCapability(name string) (Capability, bool) {
	var schema string
	switch name {
	case TaskWorkspaceList:
		schema = `{"type":"object","properties":{},"additionalProperties":false}`
	case TaskWorkspaceRead:
		schema = `{"type":"object","required":["path"],"properties":{"path":{"type":"string","minLength":1,"maxLength":1024}},"additionalProperties":false}`
	case TaskWorkspaceDelete:
		schema = `{"type":"object","required":["path"],"properties":{"path":{"type":"string","minLength":1,"maxLength":1024}},"additionalProperties":false}`
	case TaskWorkspaceCopy, TaskWorkspaceMove:
		schema = `{"type":"object","required":["path","target"],"properties":{"path":{"type":"string","minLength":1,"maxLength":1024},"target":{"type":"string","minLength":1,"maxLength":1024}},"additionalProperties":false}`
	case TaskWorkspaceWrite:
		schema = `{"type":"object","required":["path","content"],"properties":{"path":{"type":"string","minLength":1,"maxLength":1024},"content":{"type":"string","maxLength":4194304}},"additionalProperties":false}`
	default:
		return Capability{}, false
	}
	return Capability{Name: name, Description: taskWorkspaceDescription(name), Parameters: json.RawMessage(schema), Source: "workspace", ReadOnly: name == TaskWorkspaceRead || name == TaskWorkspaceList}, true
}

func taskWorkspaceDescription(name string) string {
	switch name {
	case TaskWorkspaceList:
		return "列出当前 Agent 任务工作区中的文件。"
	case TaskWorkspaceRead:
		return "读取当前 Agent 任务工作区中的文本文件。"
	case TaskWorkspaceWrite:
		return "审批后写入当前 Agent 任务工作区，并生成新的工作区版本。"
	case TaskWorkspaceCopy:
		return "复制当前任务工作区的文件到尚不存在的目标，并生成新版本。"
	case TaskWorkspaceMove:
		return "移动当前任务工作区的文件到尚不存在的目标，并生成新版本。"
	case TaskWorkspaceDelete:
		return "删除当前任务工作区内的一个文件，并生成新版本。"
	default:
		return "访问当前 Agent 任务工作区。"
	}
}

func validateTaskWorkspaceArgs(c Capability, args []byte) error {
	var input struct {
		Path    string `json:"path"`
		Target  string `json:"target"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return bad("invalid-arguments", "工作区工具参数无效")
	}
	if c.Name == TaskWorkspaceList {
		return nil
	}
	if err := workspace.ValidatePath(input.Path); err != nil {
		return err
	}
	if c.Name == TaskWorkspaceCopy || c.Name == TaskWorkspaceMove {
		if err := workspace.ValidatePath(input.Target); err != nil {
			return err
		}
	}
	if c.Name == TaskWorkspaceWrite {
		if !utf8.ValidString(input.Content) {
			return bad("invalid-arguments", "工作区文件内容必须是有效 UTF-8 文本")
		}
		if int64(len(input.Content)) > workspace.DefaultTaskBytes {
			return bad("workspace-quota", "工作区文件超过单文件大小上限")
		}
	}
	return nil
}

func (e *Extensions) executeTaskWorkspace(ctx context.Context, o Operation) (CapabilityResult, error) {
	var result CapabilityResult
	if e == nil || e.Workspaces == nil {
		return result, bad("workspace-unavailable", "任务工作区服务不可用")
	}
	var input struct {
		Path    string `json:"path"`
		Target  string `json:"target"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(o.ArgumentsJSON), &input); err != nil {
		return result, bad("invalid-arguments", "工作区工具参数无效")
	}
	switch o.Capability.Name {
	case TaskWorkspaceList:
		view, err := e.Workspaces.List(ctx, o.TaskID, o.WorkspaceRevision)
		if err != nil {
			return result, err
		}
		result.Value, err = json.Marshal(map[string]any{"version": view.Version, "files": view.Files})
		return result, err
	case TaskWorkspaceRead:
		body, version, err := e.Workspaces.ReadLimited(ctx, o.TaskID, o.WorkspaceRevision, input.Path, workspaceViewMaxBytes)
		if err != nil {
			return result, err
		}
		value := map[string]any{"path": input.Path, "revision": version.Revision, "bytes": len(body), "digest": contentDigest(body)}
		if utf8.Valid(body) && !strings.ContainsRune(string(body), '\x00') {
			value["text"] = string(body)
		} else {
			value["status"] = "unread"
			value["reason"] = "非文本文件"
		}
		result.Value, err = json.Marshal(value)
		return result, err
	case TaskWorkspaceWrite:
		version, err := e.Workspaces.PrepareWrite(ctx, o.TaskID, o.WorkspaceRevision, input.Path, strings.NewReader(input.Content))
		if err != nil {
			return result, err
		}
		result.Workspace = &version
		result.Value, err = json.Marshal(map[string]any{"path": input.Path, "revision": version.Revision, "baseRevision": version.BaseRevision, "bytes": len(input.Content), "digest": version.Digest})
		return result, err
	case TaskWorkspaceCopy, TaskWorkspaceMove, TaskWorkspaceDelete:
		var version workspace.Version
		var err error
		if o.Capability.Name == TaskWorkspaceDelete {
			version, err = e.Workspaces.PrepareDelete(ctx, o.TaskID, o.WorkspaceRevision, input.Path)
		} else {
			version, err = e.Workspaces.PrepareCopy(ctx, o.TaskID, o.WorkspaceRevision, input.Path, input.Target, o.Capability.Name == TaskWorkspaceMove)
		}
		if err != nil {
			return result, err
		}
		result.Workspace = &version
		result.Value, err = json.Marshal(map[string]any{"path": input.Path, "target": input.Target, "revision": version.Revision, "baseRevision": version.BaseRevision})
		return result, err
	default:
		return result, bad("unknown-capability", "未知工作区能力")
	}
}
