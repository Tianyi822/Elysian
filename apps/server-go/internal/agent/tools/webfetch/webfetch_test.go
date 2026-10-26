package webfetch

import (
	"context"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/tools"
	core "elysian/server/internal/agent/webfetch"
)

type stubFetcher struct{ calls atomic.Int32 }

func (s *stubFetcher) Fetch(_ context.Context, target string) (core.Result, error) {
	s.calls.Add(1)
	return core.Result{URL: target, Text: "网页正文"}, nil
}

func TestWebFetchRequiresExactDispatchAndBackendTicket(t *testing.T) {
	ctx := context.Background()
	fetcher := &stubFetcher{}
	runtime, err := tools.NewManagedRuntime(ctx, Plugin(Deps{Fetcher: fetcher, Authorize: func(ctx context.Context) error { return tools.ConsumeBackend(ctx, tools.DispatchID(ctx)) }}))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(ctx)
	authority := tools.NewAuthority()
	if err := runtime.SetAuthority(authority); err != nil {
		t.Fatal(err)
	}
	schemas := runtime.Schemas()
	if len(schemas) != 1 || schemas[0].Name != ToolName || schemas[0].Metadata.Domain != "web" || !schemas[0].Metadata.ReadOnly || schemas[0].Metadata.Exposure != "agent" {
		t.Fatalf("工具未正确投影: %+v", schemas)
	}
	args := tools.Arguments{"url": "https://example.com"}
	if _, err := runtime.Execute(ctx, ToolName, args); err == nil {
		t.Fatal("无票据调用被接受")
	}
	if fetcher.calls.Load() != 0 {
		t.Fatal("无票据触发了请求")
	}
	binding := tools.AuthorizationBinding{OperationID: "operation", DispatchID: "dispatch", Tool: ToolName, ArgumentsDigest: tools.ArgumentsDigest(args)}
	authorized, err := authority.Authorize(ctx, binding, nil, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Execute(authorized, ToolName, tools.Arguments{"url": "https://changed.example.com"}); err == nil {
		t.Fatal("修改后的 URL 被接受")
	}
	if _, err := runtime.Execute(authorized, ToolName, args); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Execute(authorized, ToolName, args); err == nil {
		t.Fatal("同一票据被重放")
	}
	if fetcher.calls.Load() != 1 {
		t.Fatal("请求次数错误")
	}
}

func TestWebFetchRejectsMissingDependencies(t *testing.T) {
	for _, deps := range []Deps{{}, {Fetcher: &stubFetcher{}}} {
		if r, err := tools.NewManagedRuntime(context.Background(), Plugin(deps)); err == nil {
			_ = r.Close(context.Background())
			t.Fatal("不完整依赖被接受")
		}
	}
}
