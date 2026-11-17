package harness

import (
	"context"
	"database/sql/driver"
	"sync/atomic"
	"testing"
	"time"

	"modernc.org/sqlite"
)

// Inject at the real driver boundary so context assembly must propagate the
// SQLite error through its nested memory reader before public error mapping.
type interruptedContextConnector struct {
	path        string
	failures    int32
	queries     atomic.Int32
	connections atomic.Int32
}

func (c *interruptedContextConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.Driver().Open(c.path)
	if err != nil {
		return nil, err
	}
	c.connections.Add(1)
	return &interruptedContextConn{Conn: conn, connector: c}, nil
}

func (*interruptedContextConnector) Driver() driver.Driver { return &sqlite.Driver{} }

type interruptedContextConn struct {
	driver.Conn
	connector *interruptedContextConnector
}

func (c *interruptedContextConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if query == "SELECT document FROM tasks WHERE id=?" && c.connector.queries.Add(1) <= c.connector.failures {
		return nil, interruptedRead{}
	}
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
}

func TestContextReadInterruptCleansUpBeforeMappingFailure(t *testing.T) {
	for _, failures := range []int32{1, 2} {
		t.Run(map[int32]string{1: "recovered", 2: "bounded"}[failures], func(t *testing.T) {
			s, path := openRuntimeTestStore(t)
			run := continuousStoreRun(t, s, "context-interrupt")
			task, err := readTask(context.Background(), s, run.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			run.Task = &task
			if err := s.close(); err != nil {
				t.Fatal(err)
			}
			connector := &interruptedContextConnector{path: path, failures: failures}
			s, err = openFixture(path, func() time.Time { return runtimeStoreTestTime }, connector)
			if err != nil {
				t.Fatal(err)
			}
			defer s.close()
			m := &Manager{store: s}
			a := &agentExecution{manager: m, run: run}
			_, groups, _, err := a.contextFacts(context.Background(), false)
			if failures == 1 {
				if err != nil || len(groups) == 0 || s.health().Read != "ready" {
					t.Fatalf("上下文未重读恢复：groups=%d err=%v health=%+v", len(groups), err, s.health())
				}
			} else {
				runtimeErrorCode(t, err, "storage-read-transient")
				if s.health().Read != "unavailable" {
					t.Fatal("丢失持续读取故障状态")
				}
			}
			if connector.queries.Load() != 2 || connector.connections.Load() != 2 || s.db.Stats().InUse != 0 {
				t.Fatalf("未废弃连接或重试越界：queries=%d connections=%d inUse=%d", connector.queries.Load(), connector.connections.Load(), s.db.Stats().InUse)
			}
			if m.storageError || s.recordsFault() != nil {
				t.Fatal("只读中断触发了全局写保护")
			}
		})
	}
}
