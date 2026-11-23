package harness

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"elysian/server/internal/agent/jsonvalue"
)

func assertAgentContractRoundTrip(t *testing.T, filename string, target any) {
	t.Helper()
	raw, err := os.ReadFile("../../../../../packages/foundation/contracts/fixtures/" + filename)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(target); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	want, err := jsonvalue.Canonical(raw)
	if err != nil {
		t.Fatal(err)
	}
	got, err := jsonvalue.Canonical(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, got) {
		t.Fatalf("共享契约往返发生变化：\n%s\n%s", want, got)
	}
}

func TestAgentResourcesSharedFixture(t *testing.T) {
	var fixture struct {
		Rule          ResourceRule  `json:"rule"`
		Lease         ResourceLease `json:"lease"`
		ProbeLease    ResourceLease `json:"probeLease"`
		WorkspaceView WorkspaceView `json:"workspaceView"`
	}
	assertAgentContractRoundTrip(t, "agent-resources.json", &fixture)
}

func TestWorkflowV2SharedFixture(t *testing.T) {
	var fixture struct {
		Definition WorkflowDefinition    `json:"definition"`
		Tree       WorkflowExecutionTree `json:"tree"`
		Recovery   WorkflowRecoveryInput `json:"recovery"`
	}
	assertAgentContractRoundTrip(t, "agent-workflow-v2.json", &fixture)
	if fixture.Definition.LanguageVersion != WorkflowV2LanguageVersion || fixture.Recovery.NodeID != fixture.Tree.Nodes[0].ID {
		t.Fatal("流程版本或恢复节点没有固定")
	}
}
