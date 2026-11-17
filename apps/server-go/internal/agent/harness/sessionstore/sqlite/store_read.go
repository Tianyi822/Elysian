package sqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log"

	"elysian/server/internal/agent/harness/sessionstore"
)

type storeQuery interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type storeReadKey struct{}

// 每次完整只读操作独占一条连接；结果集由调用方和作用域双重兜底释放。
type storeReadScope struct {
	store *store
	conn  *sql.Conn
	tx    *sql.Tx
	rows  []*sql.Rows
}

func (s *store) reader(ctx context.Context) storeQuery {
	if scope, ok := ctx.Value(storeReadKey{}).(*storeReadScope); ok && scope.store == s {
		if scope.tx != nil {
			return scope.tx
		}
		return scope
	}
	return s.db
}

func sqliteCode(err error) int {
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		return coded.Code()
	}
	return 0
}

// 仅重读 SQLITE_INTERRUPT，整次读取最多两次；写操作不得放入此回调。
func storeRead[T any](ctx context.Context, s *store, op string, read func(context.Context) (T, error)) (value T, err error) {
	if scope, ok := ctx.Value(storeReadKey{}).(*storeReadScope); ok && scope.store == s {
		return read(ctx)
	}
	defer func() {
		var public *Error
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, sessionstore.ErrNotFound) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.As(err, &public) {
			return
		}
		s.recordsStateMu.Lock()
		s.readErr = err
		s.recordsStateMu.Unlock()
	}()
	for attempt := 0; attempt < 2; attempt++ {
		if err = ctx.Err(); err != nil {
			return value, err
		}
		conn, acquireErr := s.db.Conn(ctx)
		if acquireErr != nil {
			s.diagnose(op, "read-acquire", acquireErr)
			return value, acquireErr
		}
		scope := &storeReadScope{store: s, conn: conn}
		value, err = func() (result T, readErr error) {
			// panic 也必须释放连接和结果集。
			defer conn.Close()
			defer func() {
				for _, rows := range scope.rows {
					if closeErr := rows.Close(); closeErr != nil {
						readErr = errors.Join(readErr, closeErr)
					}
				}
				if readErr != nil && ctx.Err() == nil {
					s.diagnose(op, "read", readErr)
				}
				if sqliteCode(readErr)&0xff == 9 {
					// 先释放全部结果集，再让 database/sql 废弃本次实际使用的物理连接。
					discardErr := conn.Raw(func(any) error { return driver.ErrBadConn })
					if discardErr != nil && !errors.Is(discardErr, driver.ErrBadConn) && !errors.Is(discardErr, sql.ErrConnDone) {
						readErr = errors.Join(readErr, discardErr)
					}
				}
			}()
			return read(context.WithValue(ctx, storeReadKey{}, scope))
		}()
		if err == nil || ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			if ctx.Err() != nil {
				return value, ctx.Err()
			}
			return value, err
		}
		if sqliteCode(err)&0xff != 9 {
			return value, err
		}
	}
	var zero T
	return zero, err
}

// 仅输出固定操作名、错误类型、数值码和连接计数；不输出错误正文或 SQL。
func (s *store) diagnose(op, stage string, err error) {
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, sessionstore.ErrNotFound) || err == nil || !commitUnconfirmed(err) && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
		return
	}
	var public *Error
	if errors.As(err, &public) {
		return
	}
	code := sqliteCode(err)
	cause := err
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		cause = coded.(error)
	}
	key := fmt.Sprintf("%s/%s/%T/%d", op, stage, cause, code)
	s.diagnosticsMu.Lock()
	defer s.diagnosticsMu.Unlock()
	if s.diagnostics == nil {
		s.diagnostics = make(map[string]bool)
	}
	if s.diagnostics[key] {
		return
	}
	s.diagnostics[key] = true
	stats := s.db.Stats()
	log.Printf("Agent 存储故障 operation=%s stage=%s error_type=%T sqlite_code=%d open=%d in_use=%d idle=%d wait_count=%d", op, stage, cause, code, stats.OpenConnections, stats.InUse, stats.Idle, stats.WaitCount)
}

func storeReadError(ctx context.Context, s *store, op string, read func(context.Context) error) error {
	_, err := storeRead(ctx, s, op, func(ctx context.Context) (struct{}, error) { return struct{}{}, read(ctx) })
	return err
}

func (r *storeReadScope) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	rows, err := r.conn.QueryContext(ctx, query, args...)
	if rows != nil {
		r.rows = append(r.rows, rows)
	}
	return rows, err
}

func (r *storeReadScope) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return r.conn.QueryRowContext(ctx, query, args...)
}
