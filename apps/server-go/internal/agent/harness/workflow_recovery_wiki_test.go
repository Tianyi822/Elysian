package harness

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/workspace"
)

func TestWorkflowV1RecoveryRejectsWithdrawnRunMemoryAndWorkspace(t *testing.T) {
	for _, kind := range []string{"run", "memory", "workspace"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				return CapabilityResult{BusinessError: &Failure{Code: "fixture-failed", Message: "保留可恢复失败"}}, nil
			}})
			space, err := m.CreateWikiSpace(ctx, "业务", "business")
			if err != nil {
				t.Fatal(err)
			}
			page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "recover", Title: "恢复来源", Markdown: "撤回后不得继续复用"})
			if err != nil {
				t.Fatal(err)
			}
			w := workflowStepsTest(t, m, source, workflowOneOperation("test_read"))
			w = workflowWait(t, m, w.ID, StateRecoveryRequired)
			workflowIdle(t, m)
			var version workspace.Version
			if kind == "workspace" {
				files, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = files.Close() })
				version, err = files.PrepareWrite(ctx, w.TaskID, 0, "source.txt", strings.NewReader("失效来源的文件"))
				if err != nil {
					t.Fatal(err)
				}
			}
			m.mu.Lock()
			err = m.store.write(ctx, "v1-recovery-source-fixture", func(tx *sql.Tx) error {
				id := w.ActiveRunID
				if kind == "memory" {
					id = w.TaskID + ":1"
					if err := saveWorkingMemory(ctx, tx, WorkingMemory{TaskID: w.TaskID, Revision: 1}); err != nil {
						return err
					}
				}
				if kind == "workspace" {
					id = w.TaskID + ":1"
					if err := commitWorkspaceVersion(ctx, tx, version); err != nil {
						return err
					}
				}
				return saveWorkflowWikiArtifact(ctx, tx, kind, id, w.TaskID, []WikiRef{{page.ID, page.Revision, page.Digest}})
			})
			m.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.WithdrawWikiPage(ctx, page.ID, page.Revision); err != nil {
				t.Fatal(err)
			}
			w, err = m.GetWorkflow(ctx, w.ID)
			if err != nil || len(w.AllowedActions) != 0 {
				t.Fatalf("失效%s仍提供恢复动作: %+v %v", kind, w, err)
			}
			for _, action := range []string{"continue", "retry", "renew-approval", "accept-result"} {
				_, _, err = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "withdrawn-" + action, ExpectedRevision: w.Revision, Action: action, Evidence: "新说明不能解除旧来源失效", OutputJSON: `{"ok":true}`})
				runtimeErrorCode(t, err, "wiki-context-invalidated")
			}
			if cancelled, err := m.CancelWorkflow(ctx, w.ID); err != nil || cancelled.Status != StateCancelled {
				t.Fatalf("失效来源不应阻止取消: %+v %v", cancelled, err)
			}
		})
	}
}
