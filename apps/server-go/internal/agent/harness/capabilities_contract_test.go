package harness

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/mcp"
)

func TestCapabilitiesSharedFixtureRoundTrip(t *testing.T) {
	raw, err := os.ReadFile("../../../../../packages/foundation/contracts/fixtures/agent-capabilities.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Environment    Environment        `json:"environment"`
		Capability     Capability         `json:"capability"`
		Operation      Operation          `json:"operation"`
		Approval       Approval           `json:"approval"`
		Workspace      workspace.Snapshot `json:"workspace"`
		Barrier        ExecutionBarrier   `json:"barrier"`
		ContextItem    ContextItem        `json:"contextItem"`
		Skill          skills.Skill       `json:"skill"`
		MCPServer      mcp.Server         `json:"mcpServer"`
		MCPStdioServer mcp.Server         `json:"mcpStdioServer"`
		MCPCatalog     mcp.Catalog        `json:"mcpCatalog"`
		Profile        execconfig.Profile `json:"executionProfile"`
		Grant          execconfig.Grant   `json:"grant"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&fixture); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(fixture)
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
	if !bytes.Equal(got, want) {
		t.Fatalf("Go 与共享能力契约不一致：\n%s\n%s", want, got)
	}
	if fixture.Operation.ArgumentsJSON != `{"value":9007199254740993}` || fixture.Approval.Operation.ArgumentsJSON != fixture.Operation.ArgumentsJSON || fixture.ContextItem.EventSeq != "9007199254740993" {
		t.Fatal("审批参数或事件游标发生精度丢失")
	}
	if fixture.Capability.Source != "mcp-tool" || fixture.Operation.Capability.Source != fixture.Capability.Source {
		t.Fatal("能力来源不符合运行内核契约")
	}
}
