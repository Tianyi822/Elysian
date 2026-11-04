package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

// 与 TestDockerNewRunsRefreshCatalogWithoutChangingSavedEnvironmentOrOldSnapshots 同构：
// 旧会话环境只存任务观察工具，新接受 Run 的快照应补齐 database 域全量；已存环境与旧快照不变。
func TestDatabaseRunsRefreshCatalogWithoutChangingSavedEnvironmentOrOldSnapshots(t *testing.T) {
	bridge := databaseBusinessBridge(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
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
	env.Tools = []string{"database_task_status", "database_task_logs"}
	env, err = m.PutEnvironment(ctx, session.ID, env.Revision, env)
	if err != nil {
		t.Fatal(err)
	}
	oldSnapshot, err := m.snapshot(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := dockerSnapshotTool(oldSnapshot, "database_create"); ok {
		t.Fatal("legacy snapshot unexpectedly expanded")
	}
	oldBytes, _ := json.Marshal(oldSnapshot)
	first := submitAgentTest(t, m, session, "db-new", "列出数据库")
	if run := runtimeFinished(t, m, first.ID); run.Status != StateSucceeded {
		t.Fatalf("new run: %+v", run)
	}
	for _, schema := range bridge.Schemas() {
		c, ok := dockerSnapshotTool(*first.Snapshot, schema.Name)
		if !ok || c.Source != "builtin" || c.CatalogDigest == "" {
			t.Fatalf("run lost registered tool %s: %+v", schema.Name, c)
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

// 补齐白名单只认 database 域 agent 暴露的 13 项；同名非 database、非 agent 暴露或未登记名字不放行。
func TestOrdinaryDatabaseToolRejectsUnreviewedNames(t *testing.T) {
	yes := tools.PublicSchema{Name: "database_create", Metadata: tools.Metadata{Domain: "database", Exposure: "agent"}}
	if !ordinaryDatabaseTool(yes) {
		t.Fatal("database_create 应放行")
	}
	for _, schema := range []tools.PublicSchema{
		{Name: "database_create", Metadata: tools.Metadata{Domain: "docker", Exposure: "agent"}},
		{Name: "database_create", Metadata: tools.Metadata{Domain: "database", Exposure: "http"}},
		{Name: "database_evil", Metadata: tools.Metadata{Domain: "database", Exposure: "agent"}},
	} {
		if ordinaryDatabaseTool(schema) {
			t.Fatalf("不应放行 %+v", schema)
		}
	}
}
