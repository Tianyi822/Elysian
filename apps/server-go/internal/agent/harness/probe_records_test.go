package harness

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/mcp"
)

func TestProbeRecordsIncludeRequestDecisionProgressAndCancellation(t *testing.T) {
	m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { return newProbeDuplex(), nil })
	attachProbeRuntime(t, e, server.Stdio.Image)
	ctx := context.Background()
	p, err := m.RequestProbeAccess(ctx, e, server, "probe-record-confirm")
	if err != nil {
		t.Fatal(err)
	}
	owner := recordOwner{"mcp-probe", p.ID}
	lines, _ := readRecordLines(t, fixture(m), owner)
	if len(lines) != 1 || lines[0].Type != "resource_leases" || lines[0].Action != "insert" {
		t.Fatalf("proposal omitted from same transaction ledger: %+v", lines)
	}
	if _, err := m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-record-decision", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "allow-once"}); err != nil {
		t.Fatal(err)
	}
	if settled := waitProbe(t, m, p.ID); settled.State != "completed" {
		t.Fatalf("probe did not complete: %+v", settled)
	}
	m.mu.Lock()
	lines, _ = readRecordLines(t, fixture(m), owner)
	m.mu.Unlock()
	states := map[string]bool{}
	for _, line := range lines {
		var lease ResourceLease
		if err := json.Unmarshal(line.Document, &lease); err != nil {
			t.Fatal(err)
		}
		if lease.Probe != nil {
			states[lease.Probe.State] = true
		}
	}
	for _, state := range []string{"waiting", "preparing", "running", "completed"} {
		if !states[state] {
			t.Errorf("probe ledger missing %s: %+v", state, states)
		}
	}
	for _, decision := range []string{"deny", "cancel"} {
		p, err := m.RequestProbeAccess(ctx, e, server, "probe-record-"+decision)
		if err != nil {
			t.Fatal(err)
		}
		if decision == "deny" {
			_, err = m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-denied", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "deny"})
		} else {
			_, err = m.CancelProbeAccess(ctx, p.ID, "probe-cancelled")
		}
		if err != nil {
			t.Fatal(err)
		}
		lines, _ := readRecordLines(t, fixture(m), recordOwner{"mcp-probe", p.ID})
		if len(lines) != 2 || lines[1].Action != "update" {
			t.Fatalf("probe %s missing update: %+v", decision, lines)
		}
	}
}

func TestProbeRecordsFailureFreezesDispatchAndRebuildsCommittedDecisions(t *testing.T) {
	for _, stage := range []string{"request", "decision"} {
		t.Run(stage, func(t *testing.T) {
			var opens atomic.Int32
			m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { opens.Add(1); return newProbeDuplex(), nil })
			attachProbeRuntime(t, e, server.Stdio.Image)
			ctx := context.Background()
			if err := fixture(m).waitRecords(ctx); err != nil {
				t.Fatal(err)
			}
			fail := func(string) error { return errors.New("injected probe replica failure") }
			if stage == "request" {
				fixture(m).setRecordHook(fail)
			}
			p, err := m.RequestProbeAccess(ctx, e, server, "probe-fault-"+stage)
			if err != nil {
				t.Fatal(err)
			}
			if stage == "decision" {
				if err := fixture(m).waitRecords(ctx); err != nil {
					t.Fatal(err)
				}
				fixture(m).setRecordHook(fail)
			} else {
				runtimeEventually(t, func() bool { return fixture(m).recordsFault() != nil })
			}
			_, err = m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-fault-decision", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "allow-once"})
			if stage == "request" {
				runtimeErrorCode(t, err, "record-storage-unavailable")
			} else {
				if err != nil {
					t.Fatal(err)
				}
				settled := waitProbe(t, m, p.ID)
				if settled.State != "failed" {
					t.Fatalf("replica fault did not stop preparation: %+v", settled)
				}
			}
			if fixture(m).recordsFault() == nil || opens.Load() != 0 {
				t.Fatalf("replica fault permitted external execution: fault=%v opens=%d", fixture(m).recordsFault(), opens.Load())
			}
			var count int
			if err := fixture(m).db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox WHERE owner_kind='mcp-probe' AND owner_id=?", p.ID).Scan(&count); err != nil || count < 1 {
				t.Fatalf("committed decision lost outbox: %d %v", count, err)
			}
			m = reopenOperationManager(t, m)
			lines, _ := readRecordLines(t, fixture(m), recordOwner{"mcp-probe", p.ID})
			if len(lines) != count || fixture(m).recordsFault() != nil || opens.Load() != 0 {
				t.Fatalf("recovery replayed or lost receipts: lines=%d expected=%d opens=%d", len(lines), count, opens.Load())
			}
		})
	}
}
