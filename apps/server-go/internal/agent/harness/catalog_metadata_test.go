package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func TestCapabilityMetadataDeclaresImplementationBackend(t *testing.T) {
	for source, backend := range map[string]string{"workspace": "workspace", "script": "container", BashSource: "container", BashExec: "container", BashScript: "container", "mcp-tool": "mcp", "mcp-resource": "mcp", "mcp-prompt": "mcp", "builtin": "domain", "wiki": "store", "skill-load": "store"} {
		metadata := capabilityMetadata(Capability{Name: "fixture", Source: source, ReadOnly: true})
		if metadata.Version != "1" || metadata.Backend != backend || !metadata.ReadOnly {
			t.Fatalf("source=%s metadata=%+v", source, metadata)
		}
	}
	metadata := capabilityMetadata(Capability{Metadata: tools.Metadata{Backend: "explicit", Version: "3"}})
	if metadata.Backend != "explicit" || metadata.Version != "3" {
		t.Fatalf("explicit implementation metadata lost: %+v", metadata)
	}
}

type defaultCatalogTools struct{ runtimeTestTools }

func (*defaultCatalogTools) Schemas() []tools.PublicSchema {
	return []tools.PublicSchema{
		{Name: "platform_read", Description: "read", Parameters: map[string]any{"type": "object"}, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}},
		{Name: "platform_write", Description: "write", Parameters: map[string]any{"type": "object"}, Metadata: tools.Metadata{Exposure: "agent"}},
		{Name: "human_only", Description: "admin", Parameters: map[string]any{"type": "object"}, Metadata: tools.Metadata{Exposure: "admin"}},
	}
}

func TestNewEnvironmentSelectsAllAgentExposedPlatformTools(t *testing.T) {
	m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) { d.Tools = &defaultCatalogTools{} })
	environment, err := m.environment(context.Background(), "new-session")
	if err != nil {
		t.Fatal(err)
	}
	if len(environment.Tools) != 2 || !contains(environment.Tools, "platform_read") || !contains(environment.Tools, "platform_write") || contains(environment.Tools, "human_only") {
		t.Fatalf("default tools=%v", environment.Tools)
	}
}

type sizedCatalogTools struct {
	runtimeTestTools
	count int
}

func (c *sizedCatalogTools) Schemas() []tools.PublicSchema {
	schemas := make([]tools.PublicSchema, c.count)
	for i := range schemas {
		schemas[i] = tools.PublicSchema{Name: fmt.Sprintf("platform_tool_%03d", i), Description: "读取已授权平台状态", Parameters: map[string]any{"type": "object"}, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}}
	}
	return schemas
}

type extraToolCatalog struct{ operationCatalog }

func (*extraToolCatalog) Snapshot(_ context.Context, env Environment) (CapabilitySnapshot, error) {
	return CapabilitySnapshot{Environment: env, Tools: []Capability{{Name: "extension_tool", Description: "扩展工具", Source: "mcp-tool", ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)}}}, nil
}

func TestSnapshotKeepsAuthorizedCatalogAndDefersLargeModelToolsets(t *testing.T) {
	for _, test := range []struct {
		name      string
		platform  int
		extension bool
		allowed   bool
	}{
		{"platform-default", 81, false, true},
		{"exact-limit", model.MaxToolDefinitions, false, true},
		{"combined-exact-limit", model.MaxToolDefinitions - 1, true, true},
		{"combined-over-model-limit", model.MaxToolDefinitions, true, true},
		{"small-eager", eagerToolLimit, false, true},
		{"snapshot-over-limit", maxDiscoveryCatalog, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := runtimeManager(t, &runtimeTestTools{}, func(d *Deps) {
				d.Tools = &sizedCatalogTools{count: test.platform}
				if test.extension {
					d.Catalog = &extraToolCatalog{}
				}
			})
			env, err := m.environment(context.Background(), "catalog-limit-session")
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := m.snapshot(context.Background(), env)
			if !test.allowed {
				runtimeErrorCode(t, err, "capability-limit")
				return
			}
			want := test.platform
			if test.extension {
				want++
			}
			modelCount := want
			if want > eagerToolLimit {
				want++
				modelCount = 1
			}
			if err != nil || len(snapshot.Tools) != want || len(snapshot.modelTools()) != modelCount {
				t.Fatalf("catalog or visible tools changed: catalog=%d visible=%d want=%d/%d err=%v", len(snapshot.Tools), len(snapshot.modelTools()), want, modelCount, err)
			}
		})
	}
}

func TestOversizedSavedToolSelectionRemainsEditable(t *testing.T) {
	ctx := context.Background()
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		t.Error("an oversized selection reached the model")
		return finalReply("unexpected"), nil
	}, func(d *Deps) {
		d.Tools = &sizedCatalogTools{count: maxDiscoveryCatalog}
		d.Catalog = &extraToolCatalog{}
	})
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Saved selections remain editable even when the combined catalog is too large.
	env.Revision = 1
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if err = m.store.write(ctx, "environment", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO environments(session_id,revision,document) VALUES(?,?,?)", session.ID, env.Revision, string(raw))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	catalog, err := m.ToolCatalog(ctx, session.ID, "", nil)
	if err != nil || len(catalog.Items) != maxDiscoveryCatalog+1 || catalog.SnapshotDigest != "" {
		t.Fatalf("oversized selection could not be inspected: catalog=%+v err=%v", catalog, err)
	}
	for _, item := range catalog.Items {
		if !item.Selected {
			t.Fatalf("saved selected tool was omitted: %s", item.Name)
		}
	}
	_, err = m.PutEnvironment(ctx, session.ID, env.Revision, env)
	runtimeErrorCode(t, err, "capability-limit")
	_, _, err = m.CreateTask(ctx, session.ID, AgentInput{RequestID: "oversized-catalog", Content: "检查状态"})
	runtimeErrorCode(t, err, "capability-limit")
	env.Tools = env.Tools[:len(env.Tools)-1]
	updated, err := m.PutEnvironment(ctx, session.ID, env.Revision, env)
	if err != nil || updated.Revision != 2 {
		t.Fatalf("tool selection could not be reduced: env=%+v err=%v", updated, err)
	}
	catalog, err = m.ToolCatalog(ctx, session.ID, "", nil)
	if err != nil || catalog.SnapshotDigest == "" {
		t.Fatalf("reduced selection did not restore a valid snapshot: catalog=%+v err=%v", catalog, err)
	}
	selected := 0
	for _, item := range catalog.Items {
		if item.Selected {
			selected++
		}
	}
	if selected != maxDiscoveryCatalog {
		t.Fatalf("reduced selection was truncated: selected=%d", selected)
	}
}
