package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestDatabaseToolsRetireWithoutChangingSavedEnvironmentOrOldSnapshots(t *testing.T) {
	bridge := databaseBusinessBridge(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		for _, name := range toolNames(r) {
			if retiredDatabaseTool(name) {
				t.Errorf("退役工具进入模型定义: %s", name)
			}
		}
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("done"), nil
	}, func(d *Deps) { d.Tools = bridge })
	ctx := context.Background()
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range env.Tools {
		if retiredDatabaseTool(name) {
			t.Fatalf("新环境仍默认选择退役工具: %s", name)
		}
	}
	env.Tools = []string{"database_task_status", "database_create", "docker_images_list"}
	env.TrustedReadOnly = []string{"database_task_status"}
	env, err = m.PutEnvironment(ctx, session.ID, env.Revision, env)
	if err != nil {
		t.Fatal(err)
	}
	oldSnapshot, err := m.snapshot(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := dockerSnapshotTool(oldSnapshot, "database_create"); !ok {
		t.Fatal("旧快照失去数据库工具")
	}
	oldBytes, _ := json.Marshal(oldSnapshot)
	first := submitAgentTest(t, m, session, "db-new", "列出数据库")
	if run := runtimeFinished(t, m, first.ID); run.Status != StateSucceeded {
		t.Fatalf("new run: %+v", run)
	}
	continued, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "db-continue", Content: "再检查"})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, continued.ID); run.Status != StateSucceeded {
		t.Fatalf("continued: %+v", run)
	}
	for _, run := range []Run{first, continued} {
		for _, c := range run.Snapshot.Tools {
			if retiredDatabaseTool(c.Name) {
				t.Fatalf("新接受运行包含退役工具: %s", c.Name)
			}
		}
		for _, name := range run.Snapshot.Environment.Tools {
			if retiredDatabaseTool(name) {
				t.Fatalf("运行环境包含退役工具: %s", name)
			}
		}
		if len(run.Snapshot.Environment.TrustedReadOnly) != 0 {
			t.Fatal("退役只读授权仍被继承")
		}
	}
	catalog, err := m.ToolCatalog(ctx, session.ID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range catalog.Items {
		if retiredDatabaseTool(c.Name) {
			t.Fatalf("可发现目录仍含退役工具: %s", c.Name)
		}
	}
	saved, err := m.GetEnvironment(ctx, session.ID)
	if err != nil || !reflect.DeepEqual(saved, env) {
		t.Fatalf("saved environment changed: %+v %v", saved, err)
	}
	stillOld, _ := json.Marshal(oldSnapshot)
	if string(stillOld) != string(oldBytes) {
		t.Fatal("accepted old snapshot changed")
	}
}
