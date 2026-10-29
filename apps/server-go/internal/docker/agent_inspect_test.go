package docker

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestAgentInspectRequiresExactIdentityAndDispatchAuthorization(t *testing.T) {
	ctx := context.Background()
	containerID := strings.Repeat("c", 64)
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		switch call.Path {
		case "/containers/" + containerID + "/json":
			return 200, containerInspectForStatus("running"), call.Method == "GET"
		case "/images/" + imageIDConst + "/json":
			return 200, imageInspectJSON(imageIDConst), call.Method == "GET"
		}
		return 0, "", false
	})
	denied := errors.New("dispatch denied")
	checks := 0
	facade := &AgentFacade{service: newService(engine, nil), authorize: func(context.Context) error { checks++; return denied }}
	if _, err := facade.InspectContainer(ctx, containerID); !errors.Is(err, denied) {
		t.Fatalf("container bypassed authorization: %v", err)
	}
	if _, err := facade.InspectImage(ctx, imageIDConst); !errors.Is(err, denied) {
		t.Fatalf("image bypassed authorization: %v", err)
	}
	if checks != 2 || len(engine.Requests()) != 0 {
		t.Fatal("unauthorized inspect reached Engine")
	}
	facade.authorize = func(context.Context) error { return nil }
	for _, id := range []string{"nginx:latest", "abcdef", "../json", strings.Repeat("g", 64), strings.Repeat("C", 64)} {
		if _, err := facade.InspectContainer(ctx, id); err == nil {
			t.Fatalf("accepted container ID %q", id)
		}
		if _, err := facade.InspectImage(ctx, id); err == nil {
			t.Fatalf("accepted image ID %q", id)
		}
	}
	if len(engine.Requests()) != 0 {
		t.Fatal("invalid identity reached Engine")
	}
	container, err := facade.InspectContainer(ctx, containerID)
	if err != nil || container.ID != containerID || container.Status != "running" {
		t.Fatalf("container=%+v err=%v", container, err)
	}
	for _, id := range []string{imageIDConst, "sha256:" + imageIDConst} {
		image, err := facade.InspectImage(ctx, id)
		if err != nil || image.ID != imageIDConst || image.Name != "nginx" || image.Tag != "1.27" {
			t.Fatalf("image=%+v err=%v", image, err)
		}
	}
}

func TestAgentInspectRejectsMismatchedEngineIdentity(t *testing.T) {
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if strings.HasPrefix(call.Path, "/containers/") {
			return 200, containerInspectForStatus("running"), true
		}
		return 200, imageInspectJSON(imageIDConst), true
	})
	facade := &AgentFacade{service: newService(engine, nil), authorize: func(context.Context) error { return nil }}
	for _, inspect := range []func(context.Context, string) error{
		func(ctx context.Context, id string) error { _, err := facade.InspectContainer(ctx, id); return err },
		func(ctx context.Context, id string) error { _, err := facade.InspectImage(ctx, id); return err },
	} {
		if err := inspect(context.Background(), strings.Repeat("a", 64)); err == nil || !strings.Contains(err.Error(), "ID 不匹配") {
			t.Fatalf("mismatched identity accepted: %v", err)
		}
	}
}
