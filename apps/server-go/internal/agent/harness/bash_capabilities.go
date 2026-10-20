package harness

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const (
	// Both task Bash operations share one persisted source. Their names are
	// intentionally distinct so the model schema can tell command and script
	// execution apart without treating source strings as policy.
	BashSource      = "bash"
	TaskBashCommand = "task_bash_command"
	TaskBashScript  = "task_bash_script"
	BashExec        = TaskBashCommand
	BashScript      = TaskBashScript
)

type bashArguments struct {
	Path      string   `json:"path,omitempty"`
	ProfileID string   `json:"profileId"`
	GrantID   string   `json:"grantId,omitempty"`
	Args      []string `json:"argv,omitempty"`
	Command   string   `json:"command,omitempty"`
}

func bashCapability(name string, profiles []execconfig.Profile, grants []execconfig.Grant, executor bool) (Capability, bool) {
	if !executor || len(profiles) == 0 || (name != BashExec && name != BashScript) {
		return Capability{}, false
	}
	profileIDs := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		if profile.Enabled && profile.Runtime == "bash" {
			profileIDs = append(profileIDs, profile.ID)
		}
	}
	if len(profileIDs) == 0 {
		return Capability{}, false
	}
	grantIDs := []string{""}
	for _, grant := range grants {
		if grant.Enabled {
			grantIDs = append(grantIDs, grant.ID)
		}
	}
	properties := map[string]any{
		"profileId": map[string]any{"type": "string", "enum": profileIDs},
		"grantId":   map[string]any{"type": "string", "enum": grantIDs},
	}
	required := []string{"profileId", "command"}
	if name == BashScript {
		properties["path"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 1024}
		properties["argv"] = map[string]any{"type": "array", "maxItems": 64, "items": map[string]any{"type": "string", "maxLength": 4096}}
		required = []string{"profileId", "path", "argv"}
	} else {
		properties["command"] = map[string]any{"type": "string", "minLength": 1, "maxLength": 16384}
	}
	schema, _ := json.Marshal(map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties})
	description := "审批后在受限容器中运行固定 Bash 入口；默认只写当前任务工作区，额外目录仅限固定授权。"
	if name == BashScript {
		description = "审批后在受限容器中运行当前任务工作区内的脚本；默认写入新的工作区版本，额外目录仅限固定授权。"
	}
	return Capability{Name: name, Description: description, Parameters: schema, Source: BashSource, ReadOnly: false, Metadata: tools.Metadata{Domain: "execution", Backend: "container", Action: name, Effect: "execute", Exposure: "agent", Version: "1"}}, true
}

func isBashSource(source string) bool {
	// Accept the two name-valued sources for compatibility with operations
	// persisted by the initial capability draft. New snapshots use BashSource.
	return source == BashSource || source == TaskBashCommand || source == TaskBashScript
}

func isBashScript(c Capability) bool {
	return c.Name == TaskBashScript || c.Source == TaskBashScript
}

func (e *Extensions) validateBashArguments(c Capability, args json.RawMessage) error {
	if err := mcp.Validate(c.Parameters, args); err != nil {
		return err
	}
	var input bashArguments
	if err := json.Unmarshal(args, &input); err != nil || (input.ProfileID == "" && !strings.Contains(string(c.Parameters), `"access"`)) {
		return bad("invalid-bash", "Bash 参数无效")
	}
	if isBashScript(c) {
		if err := workspace.ValidatePath(input.Path); err != nil {
			return err
		}
	} else if strings.TrimSpace(input.Command) == "" || !utf8.ValidString(input.Command) || strings.IndexByte(input.Command, 0) >= 0 || len(input.Command) > 16<<10 {
		return bad("invalid-bash", "Bash 命令必须是有效的非空文本且不超过 16 KiB")
	}
	for _, arg := range input.Args {
		if !utf8.ValidString(arg) || strings.IndexByte(arg, 0) >= 0 {
			return bad("invalid-bash", "Bash 参数包含无效字符")
		}
	}
	return nil
}

func (e *Extensions) prepareBash(ctx context.Context, s CapabilitySnapshot, o Operation) (Operation, error) {
	if isBashScript(o.Capability) && (e == nil || e.Workspaces == nil) {
		return o, bad("execution-unavailable", "Bash 脚本需要任务工作区服务")
	}
	if err := e.validateBashArguments(o.Capability, json.RawMessage(o.ArgumentsJSON)); err != nil {
		return o, err
	}
	var input bashArguments
	if err := json.Unmarshal([]byte(o.ArgumentsJSON), &input); err != nil {
		return o, bad("invalid-bash", "Bash 参数无效")
	}
	plan := &ExecutionPlan{}
	for _, profile := range s.Profiles {
		if profile.ID == input.ProfileID {
			plan.Profile = profile
			plan.Profile.Command = append([]string(nil), profile.Command...)
		}
	}
	if plan.Profile.ID == "" || !plan.Profile.Enabled || plan.Profile.Runtime != "bash" {
		return o, bad("profile-denied", "Bash 必须使用已启用的固定 Bash 执行配置")
	}
	if input.GrantID != "" {
		for _, grant := range s.Grants {
			if grant.ID == input.GrantID && grant.Enabled {
				plan.Grant = copyExecutionGrant(grant)
			}
		}
		if plan.Grant == nil {
			return o, bad("grant-denied", "挂载或出网授权未获准")
		}
	}
	if isBashScript(o.Capability) {
		if e.Workspaces == nil {
			return o, bad("workspace-unavailable", "任务工作区服务不可用")
		}
		view, err := e.Workspaces.List(ctx, o.TaskID, o.WorkspaceRevision)
		if err != nil {
			return o, err
		}
		for _, file := range view.Files {
			if file.Path == input.Path {
				plan.ScriptDigest = file.Digest
			}
		}
		if plan.ScriptDigest == "" {
			return o, bad("script-not-found", "工作区脚本不存在")
		}
	}
	o.Execution = plan
	return o, nil
}

func (e *Extensions) executeBash(ctx context.Context, o Operation) (CapabilityResult, error) {
	var result CapabilityResult
	if o.Execution == nil || e.Workspaces == nil || e.Executor == nil {
		return result, bad("execution-unavailable", "Bash 执行快照或工作区不可用")
	}
	var input bashArguments
	if err := json.Unmarshal([]byte(o.ArgumentsJSON), &input); err != nil {
		return result, bad("invalid-bash", "Bash 参数无效")
	}
	workRead, workWrite := io.Pipe()
	defer workRead.Close()
	go func() {
		_, err := e.Workspaces.Export(ctx, o.TaskID, o.WorkspaceRevision, workWrite)
		_ = workWrite.CloseWithError(err)
	}()
	out, err := os.CreateTemp("", "elysian-workspace-*.tar")
	if err != nil {
		return result, bad("workspace-storage", "无法准备工作区导出")
	}
	defer os.Remove(out.Name())
	defer out.Close()
	var value execution.ScriptResult
	if isBashScript(o.Capability) {
		value, err = e.Executor.RunWorkspaceScript(ctx, execution.WorkspaceScriptRequest{ID: o.DispatchID, Profile: o.Execution.Profile, Grant: o.Execution.Grant, ScriptPath: input.Path, Args: input.Args, WorkspaceArchive: workRead, WorkspaceOutput: out})
	} else {
		value, err = e.Executor.RunCommand(ctx, execution.CommandRequest{ID: o.DispatchID, Profile: o.Execution.Profile, Grant: o.Execution.Grant, Command: input.Command, WorkspaceArchive: workRead, WorkspaceOutput: out})
	}
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
		result.BusinessError = &Failure{Code: "bash-exit", Message: "Bash 以非零退出码结束，已确认的文件变化仍保存"}
	}
	return result, nil
}
