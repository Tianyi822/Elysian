package harness

import (
	"testing"

	hstate "elysian/server/internal/agent/harness/state"
)

func TestLegacyApprovalAllowsOnlyReconstructedSchedulingMetadata(t *testing.T) {
	original := Operation{ID: "operation", RunID: "run", TaskID: "task", ModelRequestID: "response", CallIndex: 1, ModelCallID: "call", ArgumentsJSON: `{"n":9007199254740993}`, SnapshotDigest: "snapshot", WorkspaceRevision: 4, Capability: Capability{Name: "write", Source: "mcp-tool", Ref: RevisionRef{ID: "server", Revision: 1}}, Policy: "approval-required", Status: StateWaitingApproval, ApprovalID: "approval", CallID: "persisted-call"}
	current := original
	current.ResourceClaims = []ResourceClaim{{Kind: "global", Authority: "*", Key: "*", Access: "write"}}
	current.ClaimsDigest = hstate.DigestJSON(current.ResourceClaims)
	before := hstate.DigestJSON(original)
	if !hstate.ApprovedOperationMatches(original, current) || hstate.DigestJSON(original) != before {
		t.Fatal("legacy approval cannot match reconstructed constraints or was rewritten")
	}
	for name, change := range map[string]func(*Operation){
		"arguments":  func(o *Operation) { o.ArgumentsJSON = `{"n":9007199254740992}` },
		"capability": func(o *Operation) { o.Capability.Ref.Revision++ },
		"snapshot":   func(o *Operation) { o.SnapshotDigest = "different" },
		"workspace":  func(o *Operation) { o.WorkspaceRevision++ },
		"call":       func(o *Operation) { o.ModelCallID = "other-call" },
		"policy":     func(o *Operation) { o.Policy = "trusted-read-only" },
		"status":     func(o *Operation) { o.Status = "dispatched" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := current
			change(&changed)
			if hstate.ApprovedOperationMatches(original, changed) {
				t.Fatal("changed approval binding was accepted")
			}
		})
	}
	partial := original
	partial.ResourceClaims = current.ResourceClaims
	if hstate.ApprovedOperationMatches(partial, current) {
		t.Fatal("partial resource declaration treated as legacy")
	}
	newApproval := current
	changed := current
	changed.ClaimsDigest = "changed"
	if hstate.ApprovedOperationMatches(newApproval, changed) {
		t.Fatal("v5 resource approval binding was ignored")
	}
}

func TestApprovalResourceWaitingChangesOnlySchedulingObservation(t *testing.T) {
	approved := Operation{Status: StateWaitingApproval, ArgumentsJSON: `{"id":"fixed"}`, ApprovalID: "approval", ClaimsDigest: "claims"}
	waiting := approved
	waiting.Status = StateWaitingResource
	waiting.ResourceWait = &ResourceWait{OperationID: "holder", Message: "等待资源"}
	if !hstate.ApprovedOperationMatches(approved, waiting) {
		t.Fatal("waiting observation invalidated approval")
	}
	waiting.ArgumentsJSON = `{"id":"changed"}`
	if hstate.ApprovedOperationMatches(approved, waiting) {
		t.Fatal("waiting bypassed argument binding")
	}
	waiting.ArgumentsJSON = approved.ArgumentsJSON
	waiting.DispatchID = "already-dispatched"
	if hstate.ApprovedOperationMatches(approved, waiting) {
		t.Fatal("accepted a dispatched operation as a waiter")
	}
}
