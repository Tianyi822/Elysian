package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync/atomic"
)

// AuthorizationBinding identifies one committed dispatch. No field is supplied
// by a model; the harness constructs it from its authoritative operation row.
type AuthorizationBinding struct {
	OperationID     string
	DispatchID      string
	Tool            string
	ArgumentsDigest string
	SnapshotDigest  string
	CatalogID       string
}

type Authority struct{ identity byte }
type authorizationKey struct{}
type invocationContextKey struct{}
type authorization struct {
	issuer   *Authority
	binding  AuthorizationBinding
	verify   func(context.Context) error
	payload  any
	registry atomic.Bool
	backend  atomic.Bool
}

func NewAuthority() *Authority { return &Authority{} }

func ArgumentsDigest(args Arguments) string {
	if args == nil {
		args = Arguments{}
	}
	b, err := json.Marshal(args)
	if err != nil {
		return ""
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// Authorize creates an opaque, one-use ticket after checking durable dispatch.
// The verifier is checked again when Registry admits the actual invocation.
func (a *Authority) Authorize(ctx context.Context, binding AuthorizationBinding, payload any, verify func(context.Context) error) (context.Context, error) {
	if a == nil || ctx == nil || binding.OperationID == "" || binding.DispatchID == "" || binding.Tool == "" || binding.ArgumentsDigest == "" || verify == nil {
		return nil, errors.New("工具派发授权不完整")
	}
	if err := verify(ctx); err != nil {
		return nil, err
	}
	return context.WithValue(ctx, authorizationKey{}, &authorization{issuer: a, binding: binding, payload: payload, verify: verify}), nil
}

func ticket(ctx context.Context) *authorization {
	if ctx == nil {
		return nil
	}
	v, _ := ctx.Value(authorizationKey{}).(*authorization)
	return v
}

func consumeRegistry(ctx context.Context, authority *Authority, catalog, name string, args Arguments) error {
	t := ticket(ctx)
	if t == nil || authority == nil || t.issuer != authority || t.binding.Tool != name || t.binding.ArgumentsDigest != ArgumentsDigest(args) || catalog != "" && t.binding.CatalogID != catalog {
		return errors.New("工具调用缺少匹配的持久化派发授权")
	}
	if err := t.verify(ctx); err != nil {
		return err
	}
	if !t.registry.CompareAndSwap(false, true) {
		return errors.New("工具派发授权已使用")
	}
	return nil
}

// ConsumeBackend is the second gate for Agent-only domain/executor entrypoints.
func ConsumeBackend(ctx context.Context, dispatchID string) error {
	t := ticket(ctx)
	if t == nil || !t.registry.Load() || dispatchID == "" || t.binding.DispatchID != dispatchID || !t.backend.CompareAndSwap(false, true) {
		return errors.New("执行后端缺少有效的单次工具授权")
	}
	if err := t.verify(ctx); err != nil {
		return err
	}
	return ctx.Err()
}

func DispatchID(ctx context.Context) string {
	if t := ticket(ctx); t != nil && t.registry.Load() {
		return t.binding.DispatchID
	}
	return ""
}

func Revalidate(ctx context.Context) error {
	t := ticket(ctx)
	if t == nil || !t.registry.Load() {
		return errors.New("工具调用尚未获准进入执行阶段")
	}
	return t.verify(ctx)
}

func Payload(ctx context.Context) any {
	if t := ticket(ctx); t != nil && t.registry.Load() {
		return t.payload
	}
	return nil
}
