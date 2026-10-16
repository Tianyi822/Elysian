package tools

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
)

func TestManagedRegistryRequiresExactSingleUseDispatch(t *testing.T) {
	var calls atomic.Int32
	r, err := NewManagedRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close(context.Background())
	authority := NewAuthority()
	if err := r.SetAuthority(authority); err != nil {
		t.Fatal(err)
	}
	d := Descriptor{Name: "managed_test", Description: "授权测试", Parameters: Schema{Type: SchemaObject, Required: []string{"id"}, Properties: map[string]Schema{"id": {Type: SchemaString}}}, Handler: func(c *kardia.Context, args Arguments) (any, error) {
		if err := ConsumeBackend(Lifetime(c), DispatchID(Lifetime(c))); err != nil {
			return nil, err
		}
		calls.Add(1)
		return args, nil
	}}
	if err := r.RegisterCatalog("snapshot", []Descriptor{d}); err != nil {
		t.Fatal(err)
	}
	args := Arguments{"id": "object-1"}
	if _, err := r.Execute(context.Background(), d.Name, args); err == nil {
		t.Fatal("direct call bypassed authorization")
	}
	authorized, err := authority.Authorize(context.Background(), AuthorizationBinding{OperationID: "operation", DispatchID: "dispatch", Tool: d.Name, ArgumentsDigest: ArgumentsDigest(args), CatalogID: "snapshot"}, nil, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Execute(authorized, d.Name, Arguments{"id": "other"}); err == nil {
		t.Fatal("altered args accepted")
	}
	if _, err := r.Execute(authorized, d.Name, args); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Execute(authorized, d.Name, args); err == nil {
		t.Fatal("dispatch replay accepted")
	}
	if err := ConsumeBackend(authorized, "dispatch"); err == nil {
		t.Fatal("backend ticket replay accepted")
	}
	if calls.Load() != 1 {
		t.Fatalf("handler calls=%d", calls.Load())
	}
	looked, ok := r.registry.lookup("snapshot", d.Name)
	if !ok {
		t.Fatal("missing catalog descriptor")
	}
	if _, err := looked.Handler(r.root, args); err == nil {
		t.Fatal("direct handler bypassed gate")
	}
}

func TestRegistrationRevocationCancelsRunningHandler(t *testing.T) {
	r, err := NewRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close(context.Background())
	started := make(chan struct{})
	dispose, err := r.registry.Register(Descriptor{Name: "revocation_test", Description: "撤销测试", Parameters: Schema{Type: SchemaObject}, Handler: func(c *kardia.Context, _ Arguments) (any, error) {
		close(started)
		<-Lifetime(c).Done()
		return nil, Lifetime(c).Err()
	}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := r.Execute(context.Background(), "revocation_test", nil); done <- err }()
	<-started
	if err := dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("revoked call succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("revocation did not cancel running invocation")
	}
}
