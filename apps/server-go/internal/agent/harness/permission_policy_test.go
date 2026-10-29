package harness

import (
	"context"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
	"testing"
)

func TestPermissionMatrix(t *testing.T) {
	cases := []struct {
		name              string
		op                Operation
		ask, assist, full bool
	}{
		{"workspace-read", Operation{Capability: Capability{Name: TaskWorkspaceRead, Source: "workspace", ReadOnly: true}}, true, true, true},
		{"workspace-write", Operation{Capability: Capability{Name: TaskWorkspaceWrite, Source: "workspace"}}, false, true, true},
		{"platform-confirmed-read", Operation{Capability: Capability{Name: "database_metrics", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}}}, true, true, true},
		{"platform-metrics-read", Operation{Capability: Capability{Name: "platform_metrics", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}}}, true, true, true},
		{"public-web-read", Operation{Capability: Capability{Name: "web_fetch", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}}}, true, true, true},
		{"platform-unconfirmed-read", Operation{Capability: Capability{Name: "unreviewed_read", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}}}, false, false, true},
		{"platform-write", Operation{Capability: Capability{Name: "database_remove", Source: "builtin", Metadata: tools.Metadata{Exposure: "agent"}}}, false, false, true},
		{"human-only", Operation{Capability: Capability{Name: "panel_update", Source: "builtin", Metadata: tools.Metadata{Exposure: "human"}}}, false, false, false},
		{"human-only-read", Operation{Capability: Capability{Name: "database_admin_session", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Exposure: "human", ReadOnly: true}}}, false, false, false},
		{"bash-isolated", Operation{Capability: Capability{Name: BashExec, Source: BashSource}, Execution: &ExecutionPlan{}}, false, true, true},
		{"bash-read-mount", Operation{Capability: Capability{Name: BashExec, Source: BashSource}, Execution: &ExecutionPlan{Grant: &execconfig.Grant{Directories: []execconfig.Directory{{Path: "/business", Access: "ro"}}}}}, false, true, true},
		{"bash-write-mount", Operation{Capability: Capability{Name: BashExec, Source: BashSource}, Execution: &ExecutionPlan{Grant: &execconfig.Grant{Directories: []execconfig.Directory{{Path: "/business", Access: "rw"}}}}}, false, false, true},
		{"bash-network", Operation{Capability: Capability{Name: BashExec, Source: BashSource}, Execution: &ExecutionPlan{Grant: &execconfig.Grant{Network: []execconfig.NetworkEndpoint{{Scheme: "https", Host: "example.com", Port: 443}}}}}, false, false, true},
		{"skill-script", Operation{Capability: Capability{Name: "script_run", Source: "script"}, Execution: &ExecutionPlan{}}, false, true, true},
		{"mcp-write", Operation{Capability: Capability{Name: "mcp_anything", Source: "mcp-tool"}}, false, false, true},
		{"mcp-untrusted-read", Operation{Capability: Capability{Name: "mcp_read", Source: "mcp-tool", ReadOnly: true}}, false, false, true},
	}
	for _, test := range cases {
		for _, mode := range []struct {
			value PermissionMode
			want  bool
		}{{PermissionAsk, test.ask}, {PermissionAssist, test.assist}, {PermissionFull, test.full}} {
			t.Run(test.name+"/"+string(mode.value), func(t *testing.T) {
				got, source := operationDecision(CapabilitySnapshot{PermissionMode: mode.value, PolicyVersion: PermissionPolicyVersion}, test.op)
				if got != mode.want || source == "" {
					t.Fatalf("decision=%v source=%q want=%v", got, source, mode.want)
				}
			})
		}
	}
}

func TestInvalidPermissionModeDoesNotGrantAuthority(t *testing.T) {
	if _, err := normalizePermissionMode("unrestricted"); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if canonicalPermissionMode(PermissionAsk) != "" || canonicalPermissionMode(PermissionFull) != PermissionFull {
		t.Fatal("legacy canonical mode changed")
	}
}

func TestPermissionModePinnedAndIdempotent(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		return finalReply("已完成"), nil
	}, nil)
	ctx := context.Background()
	input := AgentInput{RequestID: "permission-full", Content: "检查", PermissionMode: PermissionFull}
	run, duplicate, err := m.CreateTask(ctx, session.ID, input)
	if err != nil || duplicate {
		t.Fatalf("create: %v duplicate=%v", err, duplicate)
	}
	if run.Snapshot.PermissionMode != PermissionFull || run.Snapshot.PolicyVersion != PermissionPolicyVersion {
		t.Fatal("permission not pinned")
	}
	input.PermissionMode = PermissionAsk
	if _, _, err = m.CreateTask(ctx, session.ID, input); err == nil {
		t.Fatal("same request id changed authority")
	}
	input.PermissionMode = PermissionFull
	again, duplicate, err := m.CreateTask(ctx, session.ID, input)
	if err != nil || !duplicate || again.ID != run.ID {
		t.Fatalf("exact retry failed: %v", err)
	}
}

func TestLegacyPermissionModeKeepsMCPApproval(t *testing.T) {
	for _, version := range []string{"", "platform-tools/v1"} {
		direct, _ := operationDecision(CapabilitySnapshot{PermissionMode: PermissionFull, PolicyVersion: version}, Operation{Capability: Capability{Name: "mcp_read", Source: "mcp-tool", ReadOnly: true}})
		if direct {
			t.Fatalf("旧快照被新版权限策略扩大: %q", version)
		}
	}
}
