package harness

import (
	"context"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
)

func sessionStoreFixture(t *testing.T, s *store, suffix string, at time.Time) (Session, Task, Run) {
	t.Helper()
	session := Session{ID: "session-" + suffix, Title: "检查容器", CreatedAt: stamp(at), LastActivityAt: stamp(at), ModelProfileID: "model-one", ModelRevision: 1, LastSeq: "0"}
	if err := s.createSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	task := Task{ID: "task-" + suffix, SessionID: session.ID, RequestID: "request-" + suffix, Kind: "agent", DriverVersion: "v1", CreatedAt: stamp(at), Goal: "检查容器"}
	run := Run{ID: "run-" + suffix, SessionID: session.ID, TaskID: task.ID, RequestID: task.RequestID, Input: task.Goal, Status: StateQueued, CreatedAt: stamp(at), LastSeq: "0", Limits: DefaultAgentLimits(), Model: &model.Profile{ID: session.ModelProfileID, Revision: 1, Credential: "should-not-persist"}}
	return session, task, run
}

func acceptSessionTestRun(t *testing.T, s *store, task Task, run Run, newTask bool) Run {
	t.Helper()
	accepted, duplicate, err := s.acceptAgent(context.Background(), task, run, `{"input":"`+run.RequestID+`"}`, "message-"+run.ID, newTask)
	if err != nil || duplicate {
		t.Fatalf("接受任务失败：%+v %t %v", accepted, duplicate, err)
	}
	return accepted
}

func finishSessionTestRun(t *testing.T, s *store, id, answer string, memory *WorkingMemory) Run {
	t.Helper()
	ctx := context.Background()
	run, err := s.change(ctx, id, "finish-test", func(tx sessionstore.Tx, r *Run) error {
		r.Status = StateSucceeded
		r.EndedAt = stamp(s.now())
		r.MemoryStatus = "stale"
		if err := s.finalizeAgent(ctx, tx, r, answer, memory); err != nil {
			return err
		}
		return s.event(ctx, tx, r, "run/succeeded", "", nil, nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	return run
}
