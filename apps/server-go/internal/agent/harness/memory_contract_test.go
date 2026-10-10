package harness

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"elysian/server/internal/agent/jsonvalue"
)

func assertWikiContractRoundTrip(t *testing.T, filename string, target any) {
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

func TestWikiResourcesSharedFixture(t *testing.T) {
	var fixture struct {
		Space            WikiSpace        `json:"space"`
		Page             WikiPage         `json:"page"`
		Proposal         WikiCandidate    `json:"proposal"`
		Embedding        EmbeddingProfile `json:"embedding"`
		EmbeddingRequest EmbeddingRequest `json:"embeddingRequest"`
		Extraction       WikiJob          `json:"extraction"`
		Search           WikiSearchResult `json:"search"`
		Checks           WikiCheck        `json:"checks"`
		Index            WikiIndexStatus  `json:"index"`
		Rule             ResourceRule     `json:"rule"`
		Lease            ResourceLease    `json:"lease"`
		ProbeLease       ResourceLease    `json:"probeLease"`
		WorkspaceView    WorkspaceView    `json:"workspaceView"`
	}
	assertWikiContractRoundTrip(t, "agent-memory-resources.json", &fixture)
	if fixture.Page.Evidence[0].EventSeq != "9007199254740993" || fixture.Extraction.Usage.CachedTokens != nil {
		t.Fatal("证据序号或未知缓存信息丢失")
	}
}

func TestWorkflowV2SharedFixture(t *testing.T) {
	var fixture struct {
		Definition WorkflowDefinition    `json:"definition"`
		Tree       WorkflowExecutionTree `json:"tree"`
		Recovery   WorkflowRecoveryInput `json:"recovery"`
	}
	assertWikiContractRoundTrip(t, "agent-workflow-v2.json", &fixture)
	if fixture.Definition.LanguageVersion != WorkflowV2LanguageVersion || fixture.Recovery.NodeID != fixture.Tree.Nodes[0].ID {
		t.Fatal("流程版本或恢复节点没有固定")
	}
}
