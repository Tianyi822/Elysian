package harness

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/workspace"
)

// 文件历史仍可人工读取；隔离版本不能作为脚本的输入重新进入模型和执行链。
func (m *Manager) inheritWorkspaceWikiLocked(ctx context.Context, run Run, version workspace.Version) error {
	if version.Revision == 0 {
		return nil
	}
	invalid, err := wikiArtifactInvalid(ctx, m.store, "workspace", state.WorkspaceWikiKey(version))
	if err != nil {
		return err
	}
	if invalid {
		return &Error{Status: 409, Code: "wiki-workspace-quarantined", Message: "工作区包含已撤回 Wiki 来源的文件，请人工核实；清空隔离工作区后可重新生成"}
	}
	refs, err := wikiArtifactRefs(ctx, m.store, "workspace", state.WorkspaceWikiKey(version))
	if err != nil || len(refs) == 0 {
		return err
	}
	return writeStore(m.store, ctx, "workspace-wiki-input", func(tx sessionstore.Tx) error {
		g, e := wikiGeneration(ctx, tx, run.TaskID)
		if e != nil {
			return e
		}
		return saveWikiArtifact(ctx, tx, "run", run.ID, run.TaskID, run.ID, g, refs)
	})
}
