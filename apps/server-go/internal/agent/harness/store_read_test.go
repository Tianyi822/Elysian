package harness

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"runtime"
	"strings"
	"testing"
)

func TestStoreReadCleanupPreservesPublicErrors(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	want := bad("invalid-cursor", "原有校验响应")
	_, err := storeRead(context.Background(), s, "test-public-error", func(ctx context.Context) (int, error) {
		if _, err := s.reader(ctx).QueryContext(ctx, "SELECT 1"); err != nil {
			return 0, err
		}
		return 0, want
	})
	if storageFailure(err) != want {
		t.Fatalf("结果集清理改变了原有公开响应：%v", err)
	}
	if s.db.Stats().InUse != 0 {
		t.Fatal("错误返回后仍占用连接")
	}
}

func TestStoreDiagnosticsDeduplicateWithoutErrorContents(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	secret := "private-message-and-credential"
	err := fmt.Errorf("SQL 参数 %s：%w", secret, interruptedRead{})
	s.diagnose("test-read", "read", err)
	s.diagnose("test-read", "read", err)
	s.diagnose("test-cancel", "read", context.Canceled)
	message := output.String()
	if strings.Count(message, "Agent 存储故障") != 1 || !strings.Contains(message, "sqlite_code=9") || !strings.Contains(message, "error_type=harness.interruptedRead") || !strings.Contains(message, "in_use=") {
		t.Fatalf("故障诊断缺失或重复：%s", message)
	}
	if strings.Contains(message, secret) || strings.Contains(message, "SQL 参数") || strings.Contains(message, "test-cancel") {
		t.Fatal("日志泄漏错误正文或记录了普通取消")
	}
}

type interruptedRead struct{}

func (interruptedRead) Error() string { return "测试中断" }
func (interruptedRead) Code() int     { return 9 }

func TestSQLiteCancelledQueryDoesNotPoisonConnection(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	// 直接使用驱动，不经读取恢复兜底，防止连接替换掩盖上游泄漏回归。
	for iteration := 0; iteration < 10000; iteration++ {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			runtime.Gosched()
			cancel()
			close(done)
		}()
		rows, err := s.db.QueryContext(ctx, `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<32) SELECT x,randomblob(1000) FROM n`)
		if rows != nil {
			for rows.Next() {
				var n int
				var blob []byte
				if err = rows.Scan(&n, &blob); err != nil {
					break
				}
			}
			err = errors.Join(err, rows.Err(), rows.Close())
		}
		cancel()
		<-done
		if err != nil && !errors.Is(err, context.Canceled) && sqliteCode(err)&0xff != 9 {
			t.Fatalf("第 %d 次取消出现非预期错误：%v", iteration, err)
		}
		var count int
		if err = s.db.QueryRowContext(context.Background(), "SELECT count(*) FROM sessions").Scan(&count); err != nil {
			t.Fatalf("第 %d 次取消后连接持续失效：%v", iteration, err)
		}
	}
	if fault := s.recordsFault(); fault != nil {
		t.Fatal(fault)
	}
}

func TestStoreReadInterruptReplacesConnectionAndInitializesPragmas(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	attempts := 0
	var first any
	value, err := storeRead(context.Background(), s, "test-read", func(ctx context.Context) (int, error) {
		attempts++
		scope := ctx.Value(storeReadKey{}).(*storeReadScope)
		if err := scope.conn.Raw(func(conn any) error {
			if attempts == 1 {
				first = conn
			} else if conn == first {
				t.Error("重读复用了失效物理连接")
			}
			return nil
		}); err != nil {
			return 0, err
		}
		if attempts == 1 {
			// 故意留给作用域收尾；若在关闭 rows 之前废弃连接，此测试会死锁。
			if _, err := s.reader(ctx).QueryContext(ctx, "SELECT randomblob(1000)"); err != nil {
				return 0, err
			}
			return 0, interruptedRead{}
		}
		for pragma, want := range map[string]int{"busy_timeout": 5000, "foreign_keys": 1, "synchronous": 2} {
			var got int
			if err := s.reader(ctx).QueryRowContext(ctx, "PRAGMA "+pragma).Scan(&got); err != nil || got != want {
				t.Fatalf("替换连接的 %s=%d，期望 %d：%v", pragma, got, want, err)
			}
		}
		var journal string
		if err := s.reader(ctx).QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil || journal != "wal" {
			t.Fatalf("替换连接未启用 WAL：%s %v", journal, err)
		}
		return 42, nil
	})
	if err != nil || value != 42 || attempts != 2 {
		t.Fatalf("读取恢复结果=%d 次数=%d 错误=%v", value, attempts, err)
	}
}

func TestStoreReadRetryIsBoundedAndCancellationIsNotRetried(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		cancel bool
		want   int
	}{
		{"interrupt", interruptedRead{}, false, 2},
		{"cancelled", context.Canceled, false, 1},
		{"deadline", context.DeadlineExceeded, false, 1},
		{"cancelled-interrupt", interruptedRead{}, true, 1},
		{"other", errors.New("只读失败"), false, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			attempts := 0
			_, err := storeRead(ctx, s, "test-read", func(ctx context.Context) (int, error) {
				// 嵌套只读不增加自己的重试预算。
				return storeRead(ctx, s, "nested", func(context.Context) (int, error) {
					attempts++
					if test.cancel {
						cancel()
					}
					return 0, test.err
				})
			})
			if err == nil || attempts != test.want || s.recordsFault() != nil {
				t.Fatalf("重读次数=%d，期望=%d，错误=%v，保护=%v", attempts, test.want, err, s.recordsFault())
			}
			if test.cancel || errors.Is(test.err, context.Canceled) || errors.Is(test.err, context.DeadlineExceeded) {
				if public := storageFailure(err).(*Error); public.Status != 408 {
					t.Fatalf("取消响应=%+v", public)
				}
			}
		})
	}
}

func TestStoreWriteFailureNeverReplaysAndReadCannotClearProtection(t *testing.T) {
	for _, stage := range []string{"body", "commit", "rollback"} {
		t.Run(stage, func(t *testing.T) {
			s, _ := openRuntimeTestStore(t)
			if stage == "commit" {
				s.failNextCommit = interruptedRead{}
			}
			if stage == "rollback" {
				s.failNextRollback = errors.New("回滚结果未知")
			}
			attempts := 0
			err := s.write(context.Background(), "test-write", func(tx *sql.Tx) error {
				attempts++
				if stage != "commit" {
					return interruptedRead{}
				}
				return nil
			})
			if err == nil || attempts != 1 || s.recordsFault() == nil {
				t.Fatalf("写入次数=%d 错误=%v 保护=%v", attempts, err, s.recordsFault())
			}
			if stage != "body" && !commitUnconfirmed(err) {
				t.Fatalf("未知事务未保留候选保护：%v", err)
			}
			if _, err = s.sessions(context.Background(), "", 10); err != nil {
				t.Fatal(err)
			}
			if s.recordsFault() == nil {
				t.Fatal("成功读取清除了写入保护")
			}
		})
	}
}
