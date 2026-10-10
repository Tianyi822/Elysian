package harness

import (
	"context"
	"database/sql"
	"strconv"

	"elysian/server/internal/agent/harness/workspace"
)

func workspaceWikiKey(version workspace.Version) string {
	return version.TaskID + ":" + strconv.Itoa(version.Revision)
}

// 文件历史仍可人工读取；隔离版本不能作为脚本的输入重新进入模型和执行链。
func (m *Manager) inheritWorkspaceWikiLocked(ctx context.Context, run Run, version workspace.Version) error {
	if version.Revision == 0 {
		return nil
	}
	invalid, err := wikiArtifactInvalid(ctx, m.store.db, "workspace", workspaceWikiKey(version))
	if err != nil {
		return err
	}
	if invalid {
		return &Error{409, "wiki-workspace-quarantined", "工作区包含已撤回 Wiki 来源的文件，请人工核实；清空隔离工作区后可重新生成"}
	}
	refs, err := wikiArtifactRefs(ctx, m.store.db, "workspace", workspaceWikiKey(version))
	if err != nil || len(refs) == 0 {
		return err
	}
	return m.store.write(ctx, "workspace-wiki-input", func(tx *sql.Tx) error {
		g, e := wikiGeneration(ctx, tx, run.TaskID)
		if e != nil {
			return e
		}
		return saveWikiArtifact(ctx, tx, "run", run.ID, run.TaskID, run.ID, g, refs)
	})
}

// 人工覆盖单个文件不代表其他文件的来源失效已解除。只有空版本不再承载原事实。
func carryWorkspaceWiki(ctx context.Context, tx *sql.Tx, version workspace.Version) error {
	if version.FileCount == 0 {
		return nil
	}
	base := version.TaskID + ":" + strconv.Itoa(version.BaseRevision)
	key := workspaceWikiKey(version)
	_, err := tx.ExecContext(ctx, `INSERT INTO wiki_artifacts(kind,id,task_id,generation,invalidated) SELECT 'workspace',?,task_id,generation,invalidated FROM wiki_artifacts WHERE kind='workspace' AND id=? ON CONFLICT DO NOTHING`, key, base)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO wiki_dependencies(kind,id,page_id,revision,digest) SELECT 'workspace',?,page_id,revision,digest FROM wiki_dependencies WHERE kind='workspace' AND id=? ON CONFLICT DO NOTHING`, key, base)
	return err
}
