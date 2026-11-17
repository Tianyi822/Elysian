package harness

import (
	"context"
	"database/sql"
	"errors"
	"sort"
)

// BlockingRecovery is a current projection, separate from the immutable wait
// history. It exposes only the operation identity needed for explicit recovery.
type BlockingRecovery struct {
	RunID       string `json:"runId"`
	OperationID string `json:"operationId"`
	LeaseID     string `json:"leaseId,omitempty"`
	Tool        string `json:"tool"`
	Message     string `json:"message"`
	Verifiable  bool   `json:"verifiable"`
}

type recoveryReader interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// Use the same live protection set for the timeline and continuation. Historical
// wait records retain their original source even after that source is settled.
func currentBlockingRecovery(ctx context.Context, db recoveryReader, runID string) ([]BlockingRecovery, error) {
	result := []BlockingRecovery{}
	waiters, err := readDocuments[Operation](ctx, db, `SELECT document FROM operations WHERE run_id=? AND json_extract(document,'$.resourceWait.unknown')=1`, runID)
	if err != nil {
		return nil, err
	}
	if len(waiters) == 0 {
		return result, nil
	}
	barriers, err := readDocuments[ExecutionBarrier](ctx, db, "SELECT document FROM execution_barriers WHERE state='unknown'")
	if err != nil {
		return nil, err
	}
	leases, err := readDocuments[ResourceLease](ctx, db, "SELECT document FROM resource_leases WHERE state='unknown'")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	add := func(runID, operationID, leaseID string) {
		key := operationID
		if key == "" {
			key = "lease:" + leaseID
		}
		if !seen[key] {
			seen[key] = true
			result = append(result, BlockingRecovery{RunID: runID, OperationID: operationID, LeaseID: leaseID})
		}
	}
	for _, waiter := range waiters {
		taskControl := waiter.Capability.Metadata.Async && waiter.Capability.Metadata.Action == "cancel" && waiter.Capability.Metadata.TaskDomain != "" && waiter.Capability.Metadata.TaskIDArgument != ""
		// Older global waiters may have stored a concrete conflicting resource.
		globalFence := waiter.ResourceWait.Resource == "external:*" || externalOperation(waiter) && !taskControl
		for _, barrier := range barriers {
			if globalFence || barrier.OperationID == waiter.ResourceWait.OperationID {
				add(barrier.RunID, barrier.OperationID, "")
			}
		}
		for _, lease := range leases {
			if globalFence || resourceSetsConflict(waiter.ResourceClaims, lease.Claims) {
				leaseID := ""
				if lease.OperationID == "" {
					leaseID = lease.ID
				}
				add(lease.RunID, lease.OperationID, leaseID)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].RunID == result[j].RunID {
			return result[i].OperationID < result[j].OperationID
		}
		return result[i].RunID < result[j].RunID
	})
	return result, nil
}

// The manager lock is held by ChatSnapshot. This projection never verifies or
// changes a historical operation; recovery still requires an explicit action.
func (m *Manager) blockingRecovery(ctx context.Context, run Run) ([]BlockingRecovery, error) {
	current, err := currentBlockingRecovery(ctx, m.store.reader(ctx), run.ID)
	if err != nil {
		return nil, err
	}
	result := make([]BlockingRecovery, 0, len(current))
	for _, item := range current {
		if item.RunID != run.ID {
			result = append(result, item)
		}
	}
	verifiableRuns := map[string]bool{}
	for i := range result {
		item := &result[i]
		if item.LeaseID != "" {
			item.Tool = "资源核实"
			item.Message = "独立资源操作的结果尚未确认，请在对应设置中核实资源租约；本次操作未执行"
			continue
		}
		item.Message = "此前操作结果尚未确认，本次操作未执行；请先核实阻塞来源"
		o, err := readOperation(ctx, m.store.reader(ctx), item.OperationID)
		if errors.Is(err, sql.ErrNoRows) || isNotFound(err) {
			item.Message = "阻塞来源的操作记录不可用，资源保护保留，请检查原任务"
			continue
		}
		if err != nil {
			return nil, err
		}
		if o.RunID != item.RunID {
			continue
		}
		item.Tool = o.Capability.Name
		verifiable, exists := verifiableRuns[item.RunID]
		if !exists {
			operations, err := verificationOperations(ctx, m.store.reader(ctx), item.RunID)
			if err != nil {
				return nil, err
			}
			verifiable = len(operations) != 0
			for _, operation := range operations {
				verifiable = verifiable && m.canVerifyOperation(operation)
			}
			verifiableRuns[item.RunID] = verifiable
		}
		item.Verifiable = verifiable && m.canVerifyOperation(o)
		if !item.Verifiable {
			item.Message = "此前操作结果尚未确认，当前没有可用的自动核实通道；请在原任务核实实际状态"
		}
	}
	return result, nil
}

func verificationOperations(ctx context.Context, db recoveryReader, runID string) ([]Operation, error) {
	return readDocuments[Operation](ctx, db, `SELECT o.document FROM operations o WHERE o.run_id=? AND o.state='unknown'
AND NOT EXISTS(SELECT 1 FROM execution_barriers b WHERE b.operation_id=o.id AND b.state='reconciled')`, runID)
}

func (m *Manager) canVerifyOperation(o Operation) bool {
	if o.Status != "unknown" || o.Task == nil || o.Task.Domain == "" || o.Task.RequestID == "" || m.deps.InspectTask == nil {
		return false
	}
	if o.Task.ID != "" {
		return true
	}
	return m.deps.VerifyTask != nil && o.Task.Domain == "docker-container-operation" && o.Capability.Source == "builtin" && o.Capability.Metadata.Async &&
		(o.Capability.Name == "docker_container_create_service" && o.Capability.Metadata.Version == "3" || o.Capability.Name == "docker_container_exec" && o.Capability.Metadata.Version == "2")
}
