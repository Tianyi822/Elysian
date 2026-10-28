package docker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// 镜像源测速探针对等测试：令牌流程、索引清单、Range 截断、超时与内网拒绝。

type probeCall struct {
	path    string
	headers map[string]string
}

type probeFake struct {
	calls    []probeCall
	respond  func(call probeCall) (probeResponse, error)
	samples  []probeCall
	sampleFn func(call probeCall) (int, int64, int64, error)
}

func (f *probeFake) fetch(ctx context.Context, target registryRequestTarget, path string, headers map[string]string, maxBytes int64) (probeResponse, error) {
	call := probeCall{path: path, headers: headers}
	f.calls = append(f.calls, call)
	return f.respond(call)
}

func (f *probeFake) sample(ctx context.Context, target registryRequestTarget, path string, headers map[string]string) (int, int64, int64, error) {
	call := probeCall{path: path, headers: headers}
	f.samples = append(f.samples, call)
	return f.sampleFn(call)
}

func newProbeService(fake *probeFake) *dockerService {
	return newService(newFakeEngine(nil), func(deps *serviceDeps) {
		deps.resolveRegistry = resolvePublicAlways
		deps.fetchProbe = fake.fetch
		deps.probeSample = fake.sample
	})
}

const probeManifestWithLayer = `{"schemaVersion":2,"layers":[{"digest":"sha256:layer0"}]}`
const probeIndexManifest = `{"manifests":[{"digest":"sha256:child0"}]}`

func TestProbeRegistryMeasuresLayerSample(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(probeManifestWithLayer)}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			return http.StatusPartialContent, 1024 * 1024, 420, nil
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://dockerproxy.net")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.OK || result.ElapsedMs != 420 || result.Bytes != 1024*1024 {
		t.Fatalf("got %+v", result)
	}
	if len(fake.samples) != 1 {
		t.Fatalf("sample calls = %d", len(fake.samples))
	}
	sample := fake.samples[0]
	if sample.path != "/v2/library/alpine/blobs/sha256:layer0" {
		t.Fatalf("sample path = %q", sample.path)
	}
	if sample.headers["range"] != "bytes=0-1048575" {
		t.Fatalf("range header = %q", sample.headers["range"])
	}
}

func TestProbeRegistryFollowsBearerChallenge(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			switch {
			case strings.Contains(call.path, "/manifests/") && call.headers["authorization"] == "":
				return probeResponse{
					status:  http.StatusUnauthorized,
					headers: http.Header{"Www-Authenticate": []string{`Bearer realm="https://auth.example.com/token",service="docker.example.com"`}},
				}, nil
			case call.path == "/token?scope=repository%3Alibrary%2Falpine%3Apull&service=docker.example.com" ||
				strings.HasPrefix(call.path, "/token?"):
				return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(`{"token":"tok-1"}`)}, nil
			case strings.Contains(call.path, "/manifests/"):
				if call.headers["authorization"] != "Bearer tok-1" {
					t.Errorf("manifest retry without token: %q", call.headers["authorization"])
				}
				return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(probeManifestWithLayer)}, nil
			}
			return probeResponse{status: http.StatusNotFound}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			if call.headers["authorization"] != "Bearer tok-1" {
				t.Errorf("sample without token: %q", call.headers["authorization"])
			}
			return http.StatusOK, 2048, 12, nil
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://docker.example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.OK || result.ElapsedMs != 12 || result.Bytes != 2048 {
		t.Fatalf("got %+v", result)
	}
	if len(fake.calls) != 3 {
		t.Fatalf("fetch calls = %d: %+v", len(fake.calls), fake.calls)
	}
}

func TestProbeRegistryRejectsPrivateRealm(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			if strings.Contains(call.path, "/manifests/") && call.headers["authorization"] == "" {
				return probeResponse{
					status:  http.StatusUnauthorized,
					headers: http.Header{"Www-Authenticate": []string{`Bearer realm="https://127.0.0.1/token",service="x"`}},
				}, nil
			}
			return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(`{"token":"tok"}`)}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			t.Errorf("sample must not run after realm rejection")
			return 0, 0, 0, nil
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://docker.example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.OK || result.Reason != probeTokenReason {
		t.Fatalf("got %+v", result)
	}
	for _, call := range fake.calls {
		if strings.Contains(call.path, "127.0.0.1") {
			t.Fatalf("probe contacted private realm: %q", call.path)
		}
	}
}

func TestProbeRegistryWalksIndexManifest(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			if call.path == "/v2/library/alpine/manifests/latest" {
				return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(probeIndexManifest)}, nil
			}
			if call.path == "/v2/library/alpine/manifests/sha256:child0" {
				return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(probeManifestWithLayer)}, nil
			}
			return probeResponse{status: http.StatusNotFound}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			if call.path != "/v2/library/alpine/blobs/sha256:layer0" {
				t.Errorf("sample path = %q", call.path)
			}
			return http.StatusOK, 512, 3, nil
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://docker.example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.OK || len(fake.calls) != 2 {
		t.Fatalf("got %+v calls=%d", result, len(fake.calls))
	}
}

func TestProbeRegistryReportsTimeout(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			return probeResponse{status: http.StatusOK, headers: http.Header{}, body: []byte(probeManifestWithLayer)}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			return 0, 0, 0, errProbeTimeout
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://docker.example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.OK || result.Reason != probeTimeoutReason {
		t.Fatalf("got %+v", result)
	}
}

func TestProbeRegistryRejectsNonPublicRegistry(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			t.Errorf("fetch must not run for rejected registry")
			return probeResponse{}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			t.Errorf("sample must not run for rejected registry")
			return 0, 0, 0, nil
		},
	}
	_, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://127.0.0.1")
	wantInvalidRequest(t, err, http.StatusBadRequest, disallowedHost)
}

func TestProbeRegistryReportsManifestStatus(t *testing.T) {
	fake := &probeFake{
		respond: func(call probeCall) (probeResponse, error) {
			return probeResponse{status: http.StatusForbidden, headers: http.Header{}}, nil
		},
		sampleFn: func(call probeCall) (int, int64, int64, error) {
			return 0, 0, 0, errors.New("must not run")
		},
	}
	result, err := newProbeService(fake).ProbeRegistry(context.Background(), "https://docker.example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.OK || !strings.Contains(result.Reason, "403") {
		t.Fatalf("got %+v", result)
	}
}
