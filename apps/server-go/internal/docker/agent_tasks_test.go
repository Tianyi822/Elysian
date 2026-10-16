package docker

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

func TestAgentPullDurableIdentityKeepsUnknownDespiteInstalledTag(t *testing.T) {
	var installed atomic.Bool
	var dispatched atomic.Int32
	started := make(chan struct{})
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/images/json" {
			if installed.Load() {
				return 200, `[{"Id":"sha256:` + imageIDConst + `"}]`, true
			}
			return 200, "[]", true
		}
		if strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
	engine.streamFn = func(ctx context.Context, _ engineCall, _ func([]byte)) (seam.EngineResponse, error) {
		dispatched.Add(1)
		close(started)
		<-ctx.Done()
		return seam.EngineResponse{}, ctx.Err()
	}
	root := t.TempDir()
	facade := &AgentFacade{service: newService(engine, nil), taskRoot: root, authorize: func(context.Context) error { return nil }}
	requestID := strings.Repeat("a", 64)
	task, err := facade.Pull(context.Background(), "nginx:1.27", requestID)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("not dispatched")
	}
	installed.Store(true)
	retry, err := facade.Pull(context.Background(), "nginx:1.27", requestID)
	if err != nil || retry.ID != task.ID {
		t.Fatalf("retry=%+v err=%v", retry, err)
	}
	if _, err = facade.Pull(context.Background(), "nginx:1.28", requestID); err == nil {
		t.Fatal("changed request accepted")
	}
	if _, err = facade.PullStatus(context.Background(), "redis:7", task.ID, true); err == nil {
		t.Fatal("foreign target accepted")
	}
	if _, err = facade.PullStatus(context.Background(), task.ImageRef, task.ID, true); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = facade.Close(ctx); err != nil {
		t.Fatal(err)
	}
	restarted := &AgentFacade{service: newService(engine, nil), taskRoot: root, authorize: func(context.Context) error { return nil }}
	unknown, err := restarted.LookupPull(context.Background(), requestID)
	if err != nil || unknown.State != "unknown" {
		t.Fatalf("unknown=%+v err=%v", unknown, err)
	}
	if _, err = restarted.Pull(context.Background(), "redis:7", strings.Repeat("b", 64)); err == nil {
		t.Fatal("unknown barrier released")
	}
	observed, err := restarted.InspectPull(context.Background(), task.ID)
	if err != nil || observed.State != "unknown" || observed.Image != nil {
		t.Fatalf("existing tag resolved uncertainty: %+v err=%v", observed, err)
	}
	if _, err = restarted.Pull(context.Background(), "redis:7", strings.Repeat("b", 64)); err == nil {
		t.Fatal("existing tag released the unknown barrier")
	}
	restartedAgain := &AgentFacade{service: newService(engine, nil), taskRoot: root, authorize: func(context.Context) error { return nil }}
	observed, err = restartedAgain.LookupPull(context.Background(), requestID)
	if err != nil || observed.State != "unknown" {
		t.Fatalf("unknown was not durable: %+v err=%v", observed, err)
	}
	if dispatched.Load() != 1 {
		t.Fatalf("pull repeated %d times", dispatched.Load())
	}
}

func TestAgentPullSucceedsOnlyAfterOriginalEngineCompletion(t *testing.T) {
	var installed atomic.Bool
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/images/json" {
			if installed.Load() {
				return 200, `[{"Id":"sha256:` + imageIDConst + `"}]`, true
			}
			return 200, "[]", true
		}
		if strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
	engine.streamFn = func(context.Context, engineCall, func([]byte)) (seam.EngineResponse, error) {
		installed.Store(true)
		return seam.EngineResponse{Status: 200, Body: []byte("{\"status\":\"Download complete\"}\n")}, nil
	}
	root := t.TempDir()
	facade := &AgentFacade{service: newService(engine, nil), taskRoot: root, authorize: func(context.Context) error { return nil }}
	task, err := facade.Pull(context.Background(), "nginx:1.27", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	facade.taskWG.Wait()
	completed, err := facade.InspectPull(context.Background(), task.ID)
	if err != nil || completed.State != "succeeded" || completed.Image == nil {
		t.Fatalf("completion lost: %+v %v", completed, err)
	}
	restarted := &AgentFacade{service: newService(engine, nil), taskRoot: root}
	completed, err = restarted.InspectPull(context.Background(), task.ID)
	if err != nil || completed.State != "succeeded" || completed.Image == nil {
		t.Fatalf("durable completion lost: %+v %v", completed, err)
	}
}

func TestAgentDockerFacadeRejectsMissingAuthorization(t *testing.T) {
	engine := newFakeEngine(func(engineCall) (int, string, bool) {
		t.Fatal("backend contacted without authorization")
		return 0, "", false
	})
	facade := &AgentFacade{service: newService(engine, nil), taskRoot: t.TempDir()}
	if _, err := facade.Pull(context.Background(), "nginx:1.27", strings.Repeat("a", 64)); err == nil {
		t.Fatal("unauthorized pull")
	}
}
