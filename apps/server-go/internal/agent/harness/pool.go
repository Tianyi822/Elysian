package harness

import (
	"context"
	"errors"
	"sync"
	"time"

	"elysian/server/internal/agent/harness/worker"
)

// executionState contains only one run's in-memory protocol and cancellation
// state. Durable facts remain in the parent store and Manager.mu guards this
// projection independently for each active run.
type executionState struct {
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
	process worker.Process
	state   string
}

func (m *Manager) loop() {
	defer close(m.done)
	var workers sync.WaitGroup
	m.mu.Lock()
	for i := 0; i < m.deps.Limits.Concurrency; i++ {
		slot := &workerSlot{state: "starting"}
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
		if other.state == "ready" {
			m.workerState = "ready"
			return
		}
		if other.state == "starting" {
			m.workerState = "starting"
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
	return active < 2
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
