package mcp

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

type scopedFactoryFunc func(context.Context, Server) (Duplex, error)

func (f scopedFactoryFunc) Open(ctx context.Context, server Server) (Duplex, error) {
	return f(ctx, server)
}

type countedDuplex struct {
	*fakeDuplex
	closes atomic.Int32
}

func (d *countedDuplex) Close(ctx context.Context) error {
	d.closes.Add(1)
	return d.fakeDuplex.Close(ctx)
}

func TestStdioScopesDoNotShareConnectionOrCloseAnotherOperation(t *testing.T) {
	c := NewClient(nil, scopedFactoryFunc(func(context.Context, Server) (Duplex, error) { return newFakeDuplex(), nil }))
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	server := Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "容器", Transport: "stdio", Active: true, Stdio: &ContainerSpec{Image: "example:test", Command: []string{"serve"}}}
	aCtx, bCtx := WithScope(context.Background(), "operation-a"), WithScope(context.Background(), "operation-b")
	a, err := c.get(aCtx, server)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.get(bCtx, server)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("independent operations shared a stdio generation")
	}
	if err := c.CloseServer(aCtx, server.ID, server.Revision); err != nil {
		t.Fatal(err)
	}
	stillOpen, err := c.get(bCtx, server)
	if err != nil || stillOpen != b {
		t.Fatalf("closing first operation affected second: %v", err)
	}
	if _, exists := c.connections[connectionKey(aCtx, server)]; exists {
		t.Fatal("closed operation remained registered")
	}
}

func TestSlowStdioStartupDoesNotBlockOtherScopeAndCloseReapsStartup(t *testing.T) {
	entered := make(chan struct{})
	duplex := &countedDuplex{fakeDuplex: newFakeDuplex()}
	c := NewClient(nil, scopedFactoryFunc(func(ctx context.Context, _ Server) (Duplex, error) {
		if Scope(ctx) != "slow" {
			return newFakeDuplex(), nil
		}
		close(entered)
		<-ctx.Done()
		// A factory may finish allocating concurrently with cancellation.
		return duplex, nil
	}))
	server := Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "容器", Transport: "stdio", Active: true, Stdio: &ContainerSpec{Image: "example:test", Command: []string{"serve"}}}
	result := make(chan error, 1)
	go func() { _, err := c.get(WithScope(context.Background(), "slow"), server); result <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("startup did not begin")
	}
	fastCtx, cancel := context.WithTimeout(WithScope(context.Background(), "fast"), time.Second)
	defer cancel()
	if _, err := c.get(fastCtx, server); err != nil {
		t.Fatalf("unrelated scope blocked on slow startup: %v", err)
	}
	closeCtx, stop := context.WithTimeout(context.Background(), 2*time.Second)
	defer stop()
	if err := c.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		requireCode(t, err, "mcp-closed")
	case <-time.After(time.Second):
		t.Fatal("cancelled startup did not finish")
	}
	if duplex.closes.Load() != 1 {
		t.Fatalf("startup process leaked or closed repeatedly: %d", duplex.closes.Load())
	}
}
