package execution

import (
	"fmt"
	"sync"
	"testing"
)

func TestRuntimesConcurrentPublicationAndProcessCompletion(t *testing.T) {
	e := &Executor{active: make(map[string]*Process)}
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				id := fmt.Sprintf("scope-%d-%d", i, j)
				// These identity fields are immutable once start publishes the
				// pointer under Executor.mu. Only completion needs Process.mu.
				p := &Process{id: id, containerID: id, serverID: "server", serverRevision: 1}
				e.mu.Lock()
				e.active[id] = p
				e.mu.Unlock()
				p.mu.Lock()
				p.finished = true
				p.mu.Unlock()
				for _, runtime := range e.Runtimes() {
					if runtime.ID != runtime.ContainerID || runtime.ServerID != "server" || runtime.ServerRevision != 1 || (runtime.State != "running" && runtime.State != "stopping") {
						t.Errorf("partial process identity published: %+v", runtime)
					}
				}
				e.mu.Lock()
				delete(e.active, id)
				e.mu.Unlock()
			}
		}(i)
	}
	workers.Wait()
	if runtimes := e.Runtimes(); runtimes == nil || len(runtimes) != 0 {
		t.Fatalf("unexpected runtimes: %+v", runtimes)
	}
}
