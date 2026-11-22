package harness

import (
	"context"
	"errors"
	"sync"
	"time"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/tools"
)

// executionState contains only one run's in-memory protocol and cancellation
// state. Durable facts remain in the parent store and Manager.mu guards this
// projection independently for each active run.
type executionState struct {
	tasks        []tools.TaskReference
	maintenance  bool
	deleted      bool
	deletedDone  chan struct{}
	runID        string
	rootID       string
	cancel       context.CancelFunc
	agent        *agentExecution
	nextStep     int
	finishing    bool
	callDone     chan struct{}
	unresponsive bool
}

type workerSlot struct {
	process     worker.Process
	state       string
	claimedID   string
	claimedRoot string
}

func (slot *workerSlot) clearClaim() {
	slot.claimedID, slot.claimedRoot = "", ""
}

func (m *Manager) loop() {
	defer close(m.done)
	var workers sync.WaitGroup
	m.mu.Lock()
	for i := 0; i < m.deps.Limits.Concurrency; i++ {
		slot := &workerSlot{state: "idle"}
		m.workers = append(m.workers, slot)
		workers.Add(1)
		go func() { defer workers.Done(); m.workerLoop(slot) }()
	}
	m.mu.Unlock()
	workers.Wait()
}

func (m *Manager) setWorkerStateLocked(slot *workerSlot, state string) {
	slot.state = state
	m.workerState = "unavailable"
	allStopped := true
	for _, other := range m.workers {
		// Public readiness describes ability to accept work, including cold slots.
		if other.state == "ready" || other.state == "idle" || other.state == "starting" {
			m.workerState = "ready"
			return
		}
		allStopped = allStopped && other.state == "stopped"
	}
	if allStopped {
		m.workerState = "stopped"
	}
}

func (m *Manager) closeWorker(slot *workerSlot) {
	m.mu.Lock()
	p := slot.process
	slot.process = nil
	slot.clearClaim()
	m.setWorkerStateLocked(slot, "stopped")
	m.mu.Unlock()
	if p != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := p.Close(ctx)
		cancel()
		if err != nil {
			m.mu.Lock()
			m.closeErr = errors.Join(m.closeErr, err)
			m.mu.Unlock()
		}
	}
}

func executionRoot(r Run) string {
	if r.WorkflowID != "" {
		return "workflow:" + r.WorkflowID
	}
	if r.SessionID != "" {
		return "session:" + r.SessionID
	}
	return "run:" + r.ID
}

func (m *Manager) rootHasCapacityLocked(r Run) bool {
	if m.executionLocked(r.ID) != nil {
		return false
	}
	root := executionRoot(r)
	active := 0
	for _, execution := range m.executions {
		if execution.rootID == root {
			active++
		}
	}
	for _, slot := range m.workers {
		if slot.claimedID == r.ID {
			return false
		}
		if slot.claimedRoot == root {
			active++
		}
	}
	return active < 2
}

func (m *Manager) nextWorkerRunLocked() (Run, error) {
	view := readView(m.ctx, m.store)
	ids, err := view.Queued(m.ctx)
	if err != nil {
		return Run{}, err
	}
	for _, id := range ids {
		candidate, err := view.Get(m.ctx, id)
		if err != nil {
			return Run{}, err
		}
		if !m.rootHasCapacityLocked(candidate) {
			continue
		}
		if candidate.WorkflowID != "" {
			w, err := readWorkflow(m.ctx, m.store, candidate.WorkflowID)
			if err != nil {
				return Run{}, err
			}
			if w.GateClosed || w.Status == StateRecoveryRequired || hstate.Terminal(w.Status) {
				continue
			}
		}
		return candidate, nil
	}
	return Run{}, nil
}

// Retain these two read-only aggregate fields for older diagnostics/tests.
// Dispatch and cancellation never consult them.
func (m *Manager) refreshLegacyLocked() {
	m.activeID, m.finishing = "", false
	for id, execution := range m.executions {
		if m.activeID == "" || id < m.activeID {
			m.activeID = id
		}
		m.finishing = m.finishing || execution.finishing
	}
}

// 已删除运行的迟到错误不再冻结其他会话；其他故障来源仍保持原有屏障。
func (m *Manager) executionUnresponsiveLocked(execution *executionState, message string) {
	if execution.deleted {
		return
	}
	execution.unresponsive = true
	if !m.storageError && (m.blocked == "" || m.blockedExecution) {
		m.blocked, m.blockedExecution = message, true
	}
}
