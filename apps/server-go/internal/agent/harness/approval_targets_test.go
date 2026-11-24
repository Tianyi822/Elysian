package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
)

func TestDockerApprovalTargetEnrichesOnlyItsResponse(t *testing.T) {
	id := strings.Repeat("a", 64)
	approval := Approval{
		ID: "approval", Status: "pending", Operation: Operation{
			ArgumentsJSON: `{"id":"` + id + `","action":"restart"}`,
			Capability: Capability{Name: "docker_container_power", Source: "builtin", Metadata: tools.Metadata{
				Domain: "docker", ResourceType: "docker-container", ResourceKeyArgument: "id",
			}},
		},
	}
	calls := 0
	manager := &Manager{}
	manager.deps.DescribeTarget = func(ctx context.Context, key string) (ApprovalTarget, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok {
			t.Error("target lookup must have a deadline")
		}
		if manager.mu.TryLock() {
			manager.mu.Unlock()
		} else {
			t.Error("target lookup held the Manager lock")
		}
		return ApprovalTarget{Kind: "docker-container", Key: key, Label: "frp", Notes: []string{"特权"}}, nil
	}
	response := manager.approvalResponses(t.Context(), []Approval{approval, approval})
	payload, err := json.Marshal(response)
	persisted, _ := json.Marshal(approval)
	if err != nil || calls != 1 || strings.Count(string(payload), `"label":"frp"`) != 2 || strings.Contains(string(persisted), `"target"`) {
		t.Fatalf("unexpected target projection: %s / %s / calls=%d / err=%v", payload, persisted, calls, err)
	}
	manager.deps.DescribeTarget = func(context.Context, string) (ApprovalTarget, error) {
		return ApprovalTarget{}, errors.New("Engine unavailable")
	}
	payload, err = json.Marshal(manager.approvalResponses(t.Context(), []Approval{approval}))
	if err != nil || string(payload) != "["+string(persisted)+"]" {
		t.Fatalf("failed target lookup changed approval: %s, %v", payload, err)
	}
}
