package containerapps

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildStreamLossKeepsWorkspaceAndImageReservations(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "uncertain", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Err: io.ErrUnexpectedEOF} }
	input := BuildPlanInput{Mode: buildModeDockerfile, RequestID: "aaaaaaaa-1111-2222-3333-444444444444", Dockerfile: "Dockerfile", Context: "."}
	task, _, err := env.manager.Submit(context.Background(), dir, "uncertain", input)
	if err != nil {
		t.Fatal(err)
	}
	observed := waitForBuildTerminal(t, env.manager, "uncertain", task.ID)
	if observed.State != BuildStateInterrupted || !observed.MayStillRun || observed.DispatchStatus != buildDispatchStarted || !env.manager.HasActive("uncertain") {
		t.Fatalf("stream loss released reservations: %+v", observed)
	}
	status, err := NewAgentFacade(env.handler, nil).InspectTask(context.Background(), task.ID)
	if err != nil || status.Terminal {
		t.Fatalf("agent released stream loss barrier: %+v %v", status, err)
	}
	if release, err := env.handler.lockEditable(context.Background(), "uncertain"); err == nil {
		release()
		t.Fatal("unconfirmed build allowed workspace edits")
	}
	retry, reused, err := env.manager.Submit(context.Background(), dir, "uncertain", input)
	if err != nil || !reused || retry.ID != task.ID || !retry.MayStillRun {
		t.Fatalf("retry did not retain original task: %+v %v %v", retry, reused, err)
	}
	otherDir := env.createApp(t, "other", "FROM alpine:3\n")
	input.RequestID = "bbbbbbbb-1111-2222-3333-444444444444"
	if _, _, err = env.manager.Submit(context.Background(), otherDir, "other", input); err == nil || !strings.Contains(err.Error(), buildStageUnconfirmed) {
		t.Fatalf("unconfirmed daemon build allowed another build: %v", err)
	}
	// Even a matching task image cannot prove that the daemon's build has stopped.
	env.engine.addImage("elysian/uncertain/app:"+buildTagFor(fixedBuildClock(), task.ID), "", map[string]string{managedLabelKey: "true"})
	recoveryDeps := env.manager.deps
	recoveryDeps.Now = func() time.Time { return fixedBuildClock().Add(400 * 24 * time.Hour) }
	restarted := newBuildManager(recoveryDeps, env.manager.limits)
	retained, err := restarted.Get("uncertain", task.ID)
	if err != nil || !retained.MayStillRun || !restarted.HasActive("uncertain") {
		t.Fatalf("restart or retention cleanup released unknown task: %+v %v", retained, err)
	}
	if len(env.engine.recordedStreams()) != 1 {
		t.Fatal("unknown build was repeated")
	}
}

func TestQueuedBuildCannotDispatchAfterAnotherBecomesUnconfirmed(t *testing.T) {
	env := newBuildTestEnv(t)
	firstDir := env.createApp(t, "first", "FROM alpine:3\n")
	secondDir := env.createApp(t, "second", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Block: true} }
	first, _, err := env.manager.Submit(context.Background(), firstDir, "first", BuildPlanInput{Mode: buildModeDockerfile, RequestID: "aaaaaaaa-1111-2222-3333-444444444444", Dockerfile: "Dockerfile", Context: "."})
	if err != nil {
		t.Fatal(err)
	}
	waitForBuildDispatch(t, env.engine, 1)
	second, _, err := env.manager.Submit(context.Background(), secondDir, "second", BuildPlanInput{Mode: buildModeDockerfile, RequestID: "bbbbbbbb-1111-2222-3333-444444444444", Dockerfile: "Dockerfile", Context: "."})
	if err != nil {
		t.Fatal(err)
	}
	if err = env.manager.Cancel("first", first.ID); err != nil {
		t.Fatal(err)
	}
	first = waitForBuildTerminal(t, env.manager, "first", first.ID)
	second = waitForBuildTerminal(t, env.manager, "second", second.ID)
	if !first.MayStillRun || second.MayStillRun || second.State != BuildStateFailed || len(env.engine.recordedStreams()) != 1 {
		t.Fatalf("queued dispatch crossed uncertainty barrier: first=%+v second=%+v", first, second)
	}
}

func TestBuildRecoveryUsesPersistedDispatchEvidence(t *testing.T) {
	for _, item := range []struct {
		name, state, dispatch string
		mayStillRun           bool
	}{
		{"queued-legacy", BuildStateQueued, "", false},
		{"building-before-dispatch", BuildStateBuilding, buildDispatchPending, false},
		{"building-after-dispatch", BuildStateBuilding, buildDispatchStarted, true},
		{"building-after-completion", BuildStateBuilding, buildDispatchFinished, false},
		{"building-legacy", BuildStateBuilding, "", true},
		{"cancelled-legacy", BuildStateCancelled, "", true},
	} {
		t.Run(item.name, func(t *testing.T) {
			stateRoot := t.TempDir()
			task := BuildTask{ID: "11111111-1111-1111-1111-111111111111", Slug: "site", State: item.state, DispatchStatus: item.dispatch, CreatedAt: fixedBuildClock().Format(time.RFC3339)}
			if err := writeBuildTaskJSON(filepath.Join(stateRoot, task.ID+".json"), &task); err != nil {
				t.Fatal(err)
			}
			manager := newBuildManager(BuildDeps{Engine: newFakeBuildEngine(), StateRoot: stateRoot, LogRoot: t.TempDir(), SpoolRoot: t.TempDir(), Now: fixedBuildClock}, defaultBuildLimits())
			status, err := NewAgentFacade(Handler{Builds: manager}, nil).InspectTask(context.Background(), task.ID)
			if err != nil || status.Terminal == item.mayStillRun || manager.HasActive("site") != item.mayStillRun {
				t.Fatalf("incorrect restart evidence handling: %+v %v", status, err)
			}
		})
	}
}

func TestEngineFailureCompletionReleasesBuildReservations(t *testing.T) {
	env := newBuildTestEnv(t)
	dir := env.createApp(t, "failed", "FROM alpine:3\n")
	env.engine.scriptFn = func(url.Values) fakeBuildScript { return fakeBuildScript{Status: http.StatusInternalServerError} }
	task, _, err := env.manager.Submit(context.Background(), dir, "failed", BuildPlanInput{Mode: buildModeDockerfile, RequestID: "aaaaaaaa-1111-2222-3333-444444444444", Dockerfile: "Dockerfile", Context: "."})
	if err != nil {
		t.Fatal(err)
	}
	task = waitForBuildTerminal(t, env.manager, "failed", task.ID)
	status, err := NewAgentFacade(env.handler, nil).InspectTask(context.Background(), task.ID)
	if err != nil || !status.Terminal || task.MayStillRun || task.DispatchStatus != buildDispatchFinished || env.manager.HasActive("failed") {
		t.Fatalf("trusted completion did not release reservations: %+v %+v %v", task, status, err)
	}
}
