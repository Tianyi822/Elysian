package sqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

type Options struct {
	Connector driver.Connector
	Path      string
	Now       func() time.Time
	// Fault 仅用于确定性故障验证，生产装配保持为空。
	Fault func(stage, operation string) error
}

// Store 由装配层持有，Harness 只能看到 sessionstore.SessionStore。
type Store struct {
	*view
	store     *store
	changes   chan struct{}
	closeOnce sync.Once
	closeDone chan struct{}
	closeErr  error
}

type view struct {
	store *store
	tx    *sql.Tx
}

type transaction struct{ *view }

func (v *view) query(ctx context.Context) storeQuery {
	if v.tx != nil {
		return v.tx
	}
	return v.store.reader(ctx)
}

func (v *view) read(ctx context.Context, op string, fn func(context.Context) error) error {
	if v.tx != nil {
		return fn(context.WithValue(ctx, storeReadKey{}, &storeReadScope{store: v.store, tx: v.tx}))
	}
	return storeReadError(ctx, v.store, op, fn)
}

func Open(options Options) (*Store, error) {
	if options.Now == nil {
		options.Now = time.Now
	}
	s, err := openStore(options.Path, options.Now, options.Connector)
	if err != nil {
		return nil, err
	}
	s.fault = options.Fault
	v := &Store{store: s, view: &view{store: s}, changes: make(chan struct{}, 1), closeDone: make(chan struct{})}
	s.startRecordWorker(func() {
		select {
		case v.changes <- struct{}{}:
		default:
		}
	})
	return v, nil
}

func (v *Store) View(ctx context.Context, op string, fn func(context.Context, sessionstore.ReadView) error) error {
	return normalizeError(op, storeReadError(ctx, v.store, op, func(ctx context.Context) error { return fn(ctx, v.view) }), false)
}

func (v *Store) Update(ctx context.Context, op string, fn func(sessionstore.Tx) error) (sessionstore.CommitReceipt, error) {
	receipt := sessionstore.CommitReceipt{State: sessionstore.NotCommitted}
	err := v.store.write(ctx, op, func(tx *sql.Tx) error {
		if err := fn(&transaction{&view{store: v.store, tx: tx}}); err != nil {
			return err
		}
		var seq int64
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM agent_record_outbox").Scan(&seq); err != nil {
			return err
		}
		receipt.Watermark = sessionstore.Watermark(seq)
		return nil
	})
	if err == nil {
		receipt.State = sessionstore.Committed
	} else if commitUnconfirmed(err) {
		receipt.State = sessionstore.CommitUnknown
		err = &sessionstore.Fault{Kind: sessionstore.UnconfirmedCommit, Operation: op, Cause: err}
	}
	if err != nil {
		receipt.Watermark = 0
	}
	return receipt, normalizeError(op, err, true)
}

func (v *Store) ChangeRun(ctx context.Context, id, op string, fn func(sessionstore.Tx, *Run) error) (Run, error) {
	var r Run
	_, err := v.Update(ctx, op, func(tx sessionstore.Tx) error {
		var err error
		r, err = tx.ReadRun(ctx, id)
		if err != nil {
			return err
		}
		if err = fn(tx, &r); err != nil {
			return err
		}
		if hstate.Terminal(r.Status) {
			return tx.ReleaseSession(ctx, &r)
		}
		return nil
	})
	return r, err
}

func (v *Store) CommittedWatermark(ctx context.Context) (sessionstore.Watermark, error) {
	return viewValue(ctx, v.view, "committed-watermark", func(ctx context.Context) (sessionstore.Watermark, error) {
		var seq int64
		err := v.store.reader(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM agent_record_outbox").Scan(&seq)
		return sessionstore.Watermark(seq), err
	})
}

func (v *Store) AwaitReplicated(ctx context.Context, target sessionstore.Watermark) error {
	err := v.store.awaitRecords(ctx, int64(target))
	if err == nil || ctx.Err() != nil {
		return err
	}
	if fault := v.DispatchError(); fault != nil {
		return fault
	}
	return normalizeError("replica-watermark", err, false)
}

func (v *Store) Health() StorageHealth { return v.store.health() }
func (v *Store) DispatchError() error {
	v.store.recordsStateMu.RLock()
	defer v.store.recordsStateMu.RUnlock()
	if err := v.store.writeErr; err != nil {
		return &sessionstore.Fault{Kind: sessionstore.WriteUnavailable, Operation: "dispatch", Cause: err}
	}
	if err := v.store.recordsErr; err != nil {
		kind := sessionstore.ReplicaUnavailable
		if v.store.recordsPermanent {
			kind = sessionstore.ReplicaIntegrity
		}
		return &sessionstore.Fault{Kind: kind, Operation: "dispatch", Transient: !v.store.recordsPermanent, Cause: err}
	}
	return nil
}
func (v *Store) Changes() <-chan struct{} { return v.changes }
func (v *Store) Close(ctx context.Context) error {
	v.closeOnce.Do(func() { go func() { v.closeErr = v.store.close(); close(v.closeDone) }() })
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-v.closeDone:
		return v.closeErr
	}
}

func normalizeError(op string, err error, write bool) error {
	if err == nil {
		return nil
	}
	var fault *sessionstore.Fault
	if errors.As(err, &fault) {
		return err
	}
	if commitUnconfirmed(err) {
		return &sessionstore.Fault{Kind: sessionstore.UnconfirmedCommit, Operation: op, Cause: err}
	}
	if errors.Is(err, sql.ErrNoRows) {
		return sessionstore.ErrNotFound
	}
	var public *Error
	if errors.As(err, &public) || errors.Is(err, sessionstore.ErrNotFound) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	kind := sessionstore.ReadUnavailable
	if write {
		kind = sessionstore.WriteUnavailable
	}
	code := sqliteCode(err) & 255
	return &sessionstore.Fault{Kind: kind, Operation: op, Transient: !write && (code == 5 || code == 6 || code == 9), Cause: err}
}
func viewValue[T any](ctx context.Context, v *view, op string, fn func(context.Context) (T, error)) (result T, err error) {
	err = v.read(ctx, op, func(ctx context.Context) error { var e error; result, e = fn(ctx); return e })
	return result, normalizeError(op, err, v.tx != nil)
}

var _ sessionstore.SessionStore = (*Store)(nil)
