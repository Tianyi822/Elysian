package harness

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
)

type rowReader = sessionstore.ReadView
type storeQuery = sessionstore.ReadView

func writeStore(s sessionstore.SessionStore, ctx context.Context, op string, fn func(sessionstore.Tx) error) error {
	_, err := s.Update(ctx, op, fn)
	return err
}

func storeRead[T any](ctx context.Context, s sessionstore.SessionStore, op string, fn func(context.Context) (T, error)) (value T, err error) {
	err = s.View(ctx, op, func(ctx context.Context, view sessionstore.ReadView) error {
		ctx = context.WithValue(ctx, readViewKey{}, view)
		var readErr error
		value, readErr = fn(ctx)
		return readErr
	})
	if err != nil {
		var zero T
		return zero, err
	}
	return value, nil
}

func storeReadError(ctx context.Context, s sessionstore.SessionStore, op string, fn func(context.Context) error) error {
	return s.View(ctx, op, func(ctx context.Context, view sessionstore.ReadView) error {
		ctx = context.WithValue(ctx, readViewKey{}, view)
		return fn(ctx)
	})
}

func commitUnconfirmed(err error) bool { return sessionstore.CommitUnconfirmed(err) }

func waitRecords(s sessionstore.SessionStore, ctx context.Context) error {
	target, err := s.CommittedWatermark(ctx)
	if err != nil {
		return err
	}
	return s.AwaitReplicated(ctx, target)
}

func (m *Manager) observeStorage() {
	defer close(m.storageDone)
	changes := m.store.Changes()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-changes:
			m.signal()
		}
	}
}

type recoveryReader = sessionstore.ReadView
type reportReader = sessionstore.ReadView
type workflowQuery = sessionstore.ReadView
type workflowTreeQuery = sessionstore.ReadView
type wikiQuery = sessionstore.ReadView
type contextReader = sessionstore.ReadView
type resourceReader = sessionstore.ReadView

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func (m *Manager) validateWikiRun(ctx context.Context, q sessionstore.ReadView, id string) error {
	return q.ValidateWikiRun(ctx, id)
}

type readViewKey struct{}

func readView(ctx context.Context, fallback sessionstore.ReadView) sessionstore.ReadView {
	if v, ok := ctx.Value(readViewKey{}).(sessionstore.ReadView); ok {
		return v
	}
	return fallback
}
