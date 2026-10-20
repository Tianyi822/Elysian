package execution

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/execution/config"
)

type runtimeRoundTripper func(*http.Request) (*http.Response, error)

func (f runtimeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }
func runtimeTestEngine(t *testing.T, handler http.HandlerFunc) *Executor {
	t.Helper()
	e, err := New(Options{SupervisorPath: "/test-supervisor", MountRoot: t.TempDir(), Authorize: func(context.Context, string) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	e.client.Transport = runtimeRoundTripper(func(req *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		handler(w, req)
		return w.Result(), nil
	})
	t.Cleanup(func() { _ = e.Close(context.Background()) })
	return e
}

func TestRuntimeResolvePinsOfficialVersionDigestPlatformWithoutWrites(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	seenRegistry := false
	e := runtimeTestEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("preflight mutated engine: %s", r.Method)
		}
		switch {
		case r.URL.Path == "/v1.41/info":
			_, _ = io.WriteString(w, `{"OSType":"linux","Architecture":"aarch64"}`)
		case strings.HasPrefix(r.URL.Path, "/v1.41/images/"):
			w.WriteHeader(404)
		case r.URL.Path == "/v1.41/distribution/docker.io/library/python:3.12.9-slim-bookworm/json":
			seenRegistry = true
			_ = json.NewEncoder(w).Encode(map[string]any{"Descriptor": map[string]string{"Digest": digest}, "Platforms": []any{map[string]string{"os": "linux", "architecture": "arm64", "variant": "v8"}}})
		default:
			t.Fatalf("unexpected resolution: %s", r.URL.Path)
		}
	})
	env, err := e.ResolveRuntime(context.Background(), "python")
	if err != nil || !seenRegistry || env.Profile.Image != "docker.io/library/python@"+digest || env.Platform != "linux/arm64" || !env.RequiresDownload || env.Version != "3.12.9-slim-bookworm" {
		t.Fatalf("resolution not pinned: %+v %v", env, err)
	}
	if env.Profile.CPUMillis != 500 || env.Profile.MemoryBytes != 256<<20 || env.Profile.PIDs != 64 {
		t.Fatalf("runtime exceeds default limits: %+v", env.Profile)
	}
}

func TestRuntimeResolveReusesInstalledExactOfficialImage(t *testing.T) {
	image := "docker.io/library/bash@sha256:" + strings.Repeat("b", 64)
	e := runtimeTestEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatal("unexpected mutation")
		}
		if r.URL.Path == "/v1.41/info" {
			_, _ = io.WriteString(w, `{"OSType":"linux","Architecture":"x86_64"}`)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/v1.41/images/") {
			t.Fatalf("installed image caused registry request: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{strings.TrimPrefix(image, "docker.io/library/")}, "Config": map[string]any{}})
	})
	env, err := e.ResolveRuntime(context.Background(), "bash")
	if err != nil || env.RequiresDownload || env.Profile.Image != image {
		t.Fatalf("local reuse failed: %+v %v", env, err)
	}
}

func TestRuntimeEnsurePullsApprovedDigestAndVerifiesBeforeReuse(t *testing.T) {
	image := "docker.io/library/node@sha256:" + strings.Repeat("c", 64)
	var pulls atomic.Int32
	e := runtimeTestEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			if r.URL.Path != "/v1.41/images/create" || r.URL.Query().Get("fromImage") != image || r.URL.Query().Get("platform") != "linux/amd64" {
				t.Fatalf("pull changed approval: %s", r.URL.String())
			}
			pulls.Add(1)
			_, _ = io.WriteString(w, "{\"id\":\"layer\",\"progressDetail\":{\"current\":4,\"total\":8}}\n{\"status\":\"complete\"}\n")
			return
		}
		if pulls.Load() == 0 {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{image}, "Config": map[string]any{}})
	})
	env := RuntimeEnvironment{Profile: runtimeProfile("node", image, "node"), Platform: "linux/amd64", RequiresDownload: true}
	var states []string
	for i := 0; i < 2; i++ {
		if err := e.EnsureRuntime(context.Background(), env, func(p RuntimeProgress) error { states = append(states, p.State); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	if pulls.Load() != 1 || len(states) < 3 || states[len(states)-1] != "ready" {
		t.Fatalf("runtime not reused: pulls=%d states=%v", pulls.Load(), states)
	}
}

func TestRuntimeEnsureDoesNotDownloadMissingImageWithoutConsent(t *testing.T) {
	e := runtimeTestEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatal("download was not approved")
		}
		w.WriteHeader(404)
	})
	err := e.EnsureRuntime(context.Background(), RuntimeEnvironment{Profile: runtimeProfile("bash", "bash@sha256:"+strings.Repeat("a", 64), "bash"), Platform: "linux/amd64"}, nil)
	var got *Error
	if !errors.As(err, &got) || got.Code != "execution-runtime-missing" {
		t.Fatalf("missing image did not require renewed approval: %v", err)
	}
}

func TestInspectRuntimeUsesOnlyFrozenLocalDigestAndPlatform(t *testing.T) {
	image := "bash@sha256:" + strings.Repeat("d", 64)
	present := false
	e := runtimeTestEngine(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1.41/images/"+image+"/json" {
			t.Fatalf("verification attempted registry lookup or mutation: %s %s", r.Method, r.URL.Path)
		}
		if !present {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{image}, "Config": map[string]any{}})
	})
	env := RuntimeEnvironment{Profile: runtimeProfile("bash", image, "bash"), Platform: "linux/amd64"}
	if found, err := e.InspectRuntime(context.Background(), env); err != nil || found {
		t.Fatalf("missing readback: %v %v", found, err)
	}
	present = true
	if found, err := e.InspectRuntime(context.Background(), env); err != nil || !found {
		t.Fatalf("installed readback: %v %v", found, err)
	}
	env.Platform = "linux/arm64"
	if _, err := e.InspectRuntime(context.Background(), env); err == nil {
		t.Fatal("verification accepted different platform")
	}
}

func TestRuntimeEnsureCancellationKeepsUnknownOutcome(t *testing.T) {
	e := runtimeTestEngine(t, func(http.ResponseWriter, *http.Request) {})
	e.client.Transport = runtimeRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		reader, writer := io.Pipe()
		go func() { <-r.Context().Done(); _ = writer.CloseWithError(r.Context().Err()) }()
		return &http.Response{StatusCode: 200, Body: reader}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err := e.EnsureRuntime(ctx, RuntimeEnvironment{Profile: runtimeProfile("bash", "bash@sha256:"+strings.Repeat("a", 64), "bash"), Platform: "linux/amd64", RequiresDownload: true}, nil)
	var got *Error
	if !errors.As(err, &got) || !got.OutcomeUnknown || got.Code != "execution-image-pull-unknown" {
		t.Fatalf("cancelled pull lost uncertainty: %v", err)
	}
}

func TestRuntimeAuthorizationCannotCrossScopeOrBypassLegacyRevocation(t *testing.T) {
	e, f := newFakeExecutor(t)
	profile := runtimeProfile("bash", "bash@sha256:"+strings.Repeat("a", 64), "bash")
	grant := RuntimeGrant("approval-one", config.AccessScope{})
	request := StdioRequest{ID: "dispatch-one", Profile: profile, Grant: &grant, Command: []string{"bash"}}
	if _, err := e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("synthetic runtime accepted without host authorization")
	}
	e.options.ResolveRuntimeAuthorization = func(context.Context, string) (*RuntimeAuthorization, error) {
		return &RuntimeAuthorization{ID: "approval-one", DispatchID: "dispatch-one", ScopeID: "another-scope", Profile: profile, Grant: &grant, Command: request.Command}, nil
	}
	if _, err := e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("cross-scope authorization accepted")
	}
	profile.ID = "profile-legacy"
	grant.ID = "grant-legacy"
	request.Profile, request.Grant = profile, &grant
	e.options.ResolveRuntimeAuthorization = func(context.Context, string) (*RuntimeAuthorization, error) {
		return &RuntimeAuthorization{ID: "approval-one", DispatchID: "dispatch-one", ScopeID: "dispatch-one", Profile: profile, Grant: &grant, Command: request.Command}, nil
	}
	e.options.ResolveProfile = func(string, int) (*config.Profile, error) { p := profile; p.Enabled = false; return &p, nil }
	if _, err := e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("runtime fact bypassed legacy profile revocation")
	} else {
		var got *Error
		if !errors.As(err, &got) || got.Code != "execution-profile-disabled" {
			t.Fatalf("legacy check was bypassed: %v", err)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != 0 {
		t.Fatal("rejected authorization created containers")
	}
}

func TestRuntimeAuthorizationChecksExactCommandAndRevokesActiveProcess(t *testing.T) {
	e, _ := newFakeExecutor(t)
	profile := runtimeProfile("bash", "bash@sha256:"+strings.Repeat("a", 64), "bash")
	grant := RuntimeGrant("approval-one", config.AccessScope{})
	command := []string{"bash", "-c", "printf allowed"}
	e.options.ResolveRuntimeAuthorization = func(context.Context, string) (*RuntimeAuthorization, error) {
		return &RuntimeAuthorization{ID: "approval-one", DispatchID: "dispatch-one", ScopeID: "dispatch-one", Profile: profile, Grant: &grant, Command: command}, nil
	}
	request := StdioRequest{ID: "dispatch-one", Profile: profile, Grant: &grant, Command: []string{"bash", "-c", "printf changed"}}
	if _, err := e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("changed command accepted with original authorization")
	}
	request.Command = append([]string{}, command...)
	p, err := e.OpenStdio(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if p.authorizationID != "approval-one" {
		t.Fatal("active process lost authorization identity")
	}
	if err := e.RevokeRuntimeAuthorization(context.Background(), "approval-one"); err != nil {
		t.Fatal(err)
	}
	if len(e.Runtimes()) != 0 {
		t.Fatal("revocation left active execution process")
	}
	if _, err := e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("revoked runtime authorization was reused")
	}
}
