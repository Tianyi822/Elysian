package database

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"

	"elysian/server/internal/shared"
)

// SQLite 托管 worker：自身二进制的 `__sqlite-worker` 子命令（go-plan §11 D10），
// uid 2001 降权 + stdin/stdout JSON 行 IPC + 启动 PRAGMA 双限额。就绪帧
// {"type":"ready"}；每帧请求 {id,kind,sql?,target?,limitBytes?} →
// {id,ok:true,value} 或 {id,ok:false,error,code?}（code 为 fs errno 名，供上层
// 归类中文）。子命令分发在 cmd/elysian（集成阶段接线，见 gaps）。

// workerRequest 父进程 → worker 的请求帧。
type workerRequest struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"`
	SQL        *string `json:"sql,omitempty"`
	Target     *string `json:"target,omitempty"`
	LimitBytes *int64  `json:"limitBytes,omitempty"`
}

// workerResponse worker → 父进程的应答帧。
type workerResponse struct {
	ID    int64           `json:"id"`
	Type  string          `json:"type,omitempty"`
	OK    *bool           `json:"ok,omitempty"`
	Value json.RawMessage `json:"value,omitempty"`
	Error string          `json:"error,omitempty"`
	Code  string          `json:"code,omitempty"`
}

// probeValue probe/init/validate 的 value 形状（键序对齐 TS 版对象字面量）。
type probeValue struct {
	TableCount int64  `json:"tableCount"`
	Version    string `json:"version"`
	Bytes      int64  `json:"bytes"`
}

// exportValue export 的 value 形状。
type exportValue struct {
	Bytes int64 `json:"bytes"`
}

// workerRun 一个已打开的 SQLite worker 会话（worker 侧）。
type workerRun struct {
	db        *sql.DB
	pageSize  int64
	probeStmt *sql.Stmt
}

// openWorkerRun 按环境打开库并施加启动 PRAGMA；create=false 时文件必须已存在。
func openWorkerRun(file string, create bool) (*workerRun, error) {
	if !create {
		if _, err := os.Stat(file); err != nil {
			if isNoEntry(err) {
				return nil, errors.New("unable to open database file")
			}
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, err
	}
	// 单连接常驻：会话级 PRAGMA（max_page_count 按配额动态重设）不因换连接丢失。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	for _, pragma := range []string{
		"PRAGMA trusted_schema=OFF",
		"PRAGMA hard_heap_limit=134217728",
		"PRAGMA busy_timeout=3000",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, err
		}
	}
	var pageSize int64
	if err := db.QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA max_page_count=%d", (1024*1024*1024)/pageSize)); err != nil {
		db.Close()
		return nil, err
	}
	return &workerRun{db: db, pageSize: pageSize}, nil
}

// probe 采样表数、版本与文件字节数；full 时先做完整性校验。
func (w *workerRun) probe(file string, full bool) (probeValue, error) {
	if full {
		var quickCheck sql.NullString
		if err := w.db.QueryRow("PRAGMA quick_check").Scan(&quickCheck); err != nil {
			return probeValue{}, err
		}
		if !quickCheck.Valid || quickCheck.String != "ok" {
			return probeValue{}, errors.New("SQLite 文件完整性校验失败")
		}
	}
	var tableCount int64
	if err := w.db.QueryRow("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tableCount); err != nil {
		return probeValue{}, err
	}
	var version string
	if err := w.db.QueryRow("SELECT sqlite_version() AS version").Scan(&version); err != nil {
		return probeValue{}, err
	}
	info, err := os.Stat(file)
	if err != nil {
		return probeValue{}, err
	}
	return probeValue{TableCount: tableCount, Version: version, Bytes: info.Size()}, nil
}

// initCreate 建临时表再删，随后全量 probe。
func (w *workerRun) initCreate(file string) (probeValue, error) {
	if _, err := w.db.Exec("CREATE TABLE __elysian_init (id INTEGER)"); err != nil {
		return probeValue{}, err
	}
	if _, err := w.db.Exec("DROP TABLE __elysian_init"); err != nil {
		return probeValue{}, err
	}
	return w.probe(file, true)
}

// applyLimitBytes 按会话配额重设 max_page_count。
func (w *workerRun) applyLimitBytes(limit int64) error {
	if limit < 0 {
		limit = 0
	}
	_, err := w.db.Exec(fmt.Sprintf("PRAGMA max_page_count=%d", limit/w.pageSize))
	return err
}

// execute 校验并执行一条 SQL，输出行集（截断规则与文案逐字对齐 TS 版）。
// 全程持单连接：无结果集语句经 Query 执行（modernc 对 0 列语句即时返回），
// 随后在同一连接上以 SELECT changes() 取影响行数（bun:sqlite statement.run()
// 的 changes 等价物；modernc 的 driver.Rows 不暴露受影响行数）。
func (w *workerRun) execute(ctx context.Context, sqlText string) ([]string, error) {
	if err := validateSqliteStatement(sqlText); err != nil {
		return nil, err
	}
	conn, err := w.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	rows, err := conn.QueryContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return nil, err
	}
	if len(columns) == 0 {
		rows.Close()
		var changes int64
		if err := conn.QueryRowContext(ctx, "SELECT changes()").Scan(&changes); err != nil {
			return nil, err
		}
		return []string{fmt.Sprintf("执行成功，影响 %d 行。", changes)}, nil
	}
	output := []string{strings.Join(columns, "\t")}
	byteCount := len(output[0])
	count := 0
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	for rows.Next() {
		largeCell := false
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		cells := make([]string, len(values))
		for i, value := range values {
			if text, ok := value.(string); ok && len(text) > 1024*1024 {
				largeCell = true
				cells[i] = ""
				continue
			}
			cells[i] = sqliteCellString(value)
		}
		if largeCell {
			output = append(output, "单元格超过 1 MiB，已截断。")
			break
		}
		line := strings.Join(cells, "\t")
		byteCount += len(line)
		if byteCount > 1024*1024 {
			output = append(output, "结果超过 1 MiB，已截断。")
			break
		}
		output = append(output, line)
		count++
		if count >= 500 {
			output = append(output, "结果达到 500 行上限，已截断。")
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	output = append(output, fmt.Sprintf("返回 %d 行。", count))
	return output, nil
}

// sqliteCellString 单元格字符串化：NULL / BLOB / 其余 String(value)。
func sqliteCellString(value any) string {
	switch v := value.(type) {
	case nil:
		return "NULL"
	case []byte:
		return fmt.Sprintf("[BLOB %d 字节]", len(v))
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

// exportSnapshot VACUUM INTO 一致性快照。
func (w *workerRun) exportSnapshot(target string) (exportValue, error) {
	if _, err := w.db.Exec("VACUUM INTO ?", target); err != nil {
		return exportValue{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return exportValue{}, err
	}
	return exportValue{Bytes: info.Size()}, nil
}

// errnoCode 从错误里提取 fs errno 名（ENOENT 等），供上层归类中文。
func errnoCode(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errnoName(errno)
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		if errors.As(pathErr.Err, &errno) {
			return errnoName(errno)
		}
	}
	return ""
}

// errnoName 常见 errno 的符号名。
func errnoName(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EDQUOT:
		return "EDQUOT"
	case syscall.EROFS:
		return "EROFS"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	case syscall.EIO:
		return "EIO"
	case syscall.EMFILE:
		return "EMFILE"
	case syscall.ENFILE:
		return "ENFILE"
	default:
		return "ERRNO_" + strconv.Itoa(int(errno))
	}
}

// RunSQLiteWorker IPC 主循环：读 env 里的文件与 create 开关，stdin/stdout 帧循环。
// 返回进程退出码（0 正常收尾；2 缺少文件参数或库打不开）。
func RunSQLiteWorker(stdin io.Reader, stdout io.Writer, getenv func(string) string) int {
	file := getenv("ELYSIAN_SQLITE_FILE")
	if file == "" {
		return 2
	}
	create := getenv("ELYSIAN_SQLITE_CREATE") == "1"
	run, err := openWorkerRun(file, create)
	if err != nil {
		return 2
	}
	defer run.db.Close()
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(workerResponse{Type: "ready"}); err != nil {
		return 2
	}
	reader := bufio.NewReader(stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var request workerRequest
			if json.Unmarshal(line, &request) == nil {
				response := workerResponse{ID: request.ID}
				value, handleErr := handleWorkerRequest(run, file, request)
				if handleErr != nil {
					response.OK = boolPtr(false)
					response.Error = handleErr.Error()
					response.Code = errnoCode(handleErr)
				} else {
					response.OK = boolPtr(true)
					response.Value = value
				}
				if encodeErr := encoder.Encode(response); encodeErr != nil {
					return 0
				}
			}
		}
		if err != nil {
			return 0
		}
	}
}

// handleWorkerRequest 单帧分派。
func handleWorkerRequest(run *workerRun, file string, request workerRequest) (json.RawMessage, error) {
	switch request.Kind {
	case "init":
		value, err := run.initCreate(file)
		return marshalWorkerValue(value, err)
	case "probe":
		value, err := run.probe(file, false)
		return marshalWorkerValue(value, err)
	case "validate":
		value, err := run.probe(file, true)
		return marshalWorkerValue(value, err)
	case "execute":
		if request.SQL == nil {
			return nil, errors.New("SQLite 操作无效")
		}
		if request.LimitBytes != nil {
			if err := run.applyLimitBytes(*request.LimitBytes); err != nil {
				return nil, err
			}
		}
		lines, err := run.execute(context.Background(), *request.SQL)
		return marshalWorkerValue(lines, err)
	case "export":
		if request.Target == nil {
			return nil, errors.New("SQLite 操作无效")
		}
		value, err := run.exportSnapshot(*request.Target)
		return marshalWorkerValue(value, err)
	default:
		return nil, errors.New("SQLite 操作无效")
	}
}

// marshalWorkerValue 把结果序列化为应答 value；err 非空时原样带回。
func marshalWorkerValue(value any, err error) (json.RawMessage, error) {
	if err != nil {
		return nil, err
	}
	data, err := shared.MarshalJSON(value)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

// ---------- 父进程侧：子进程启动与帧收发 ----------

// sqliteWorkerCommand 子进程启动规格（可注入，供测试用测试二进制自举）。
type sqliteWorkerCommand struct {
	Path string
	Args []string
	UID  *uint32
	GID  *uint32
}

// defaultWorkerCommand 生产启动规格：自身二进制 + __sqlite-worker 子命令。
func defaultWorkerCommand() sqliteWorkerCommand {
	executable, err := os.Executable()
	if err != nil {
		executable = os.Args[0]
	}
	return sqliteWorkerCommand{Path: executable, Args: []string{"__sqlite-worker"}}
}

// pendingTask 一个在途请求。
type pendingTask struct {
	response chan workerResponse
	timer    *time.Timer
}

// sqliteWorker 父进程侧的 worker 会话。
type sqliteWorker struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	mu       sync.Mutex
	pending  map[int64]*pendingTask
	ready    chan error
	exited   chan struct{}
	closed   bool
	sequence int64
}

// spawnSqliteWorker 启动 worker 子进程并等待就绪帧。
func spawnSqliteWorker(file string, create bool, command sqliteWorkerCommand) (*sqliteWorker, error) {
	cmd := exec.Command(command.Path, command.Args...)
	cmd.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=/tmp",
		"ELYSIAN_SQLITE_FILE=" + file,
		"ELYSIAN_SQLITE_CREATE=" + map[bool]string{true: "1", false: "0"}[create],
	}
	if command.UID != nil && command.GID != nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: *command.UID, Gid: *command.GID}}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// worker 崩溃信息进父进程 stderr 诊断；正常路径 worker 不写 stderr。
	cmd.Stderr = os.Stderr
	worker := &sqliteWorker{
		cmd: cmd, stdin: stdin, pending: map[int64]*pendingTask{},
		ready: make(chan error, 1), exited: make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go worker.readLoop(stdout)
	go worker.waitLoop()
	select {
	case err := <-worker.ready:
		if err != nil {
			worker.kill()
			return nil, err
		}
		return worker, nil
	case <-time.After(5 * time.Second):
		worker.kill()
		return nil, errors.New("SQLite 进程启动超时")
	}
}

// readLoop 消费 stdout 帧：ready / 应答分发。
func (w *sqliteWorker) readLoop(stdout io.Reader) {
	reader := bufio.NewReader(stdout)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var response workerResponse
			if json.Unmarshal(line, &response) == nil {
				if response.Type == "ready" {
					w.ready <- nil
					continue
				}
				w.dispatch(response)
			}
		}
		if err != nil {
			close(w.exited)
			w.failAllPending()
			return
		}
	}
}

// waitLoop 进程退出：未就绪即失败，在途请求按会话中断拒绝。
func (w *sqliteWorker) waitLoop() {
	_ = w.cmd.Wait()
	select {
	case <-w.ready:
	default:
		w.ready <- errors.New("SQLite 进程启动失败")
	}
}

// dispatch 把应答帧派发给在途请求（先占位删除者独占发送权）。
func (w *sqliteWorker) dispatch(response workerResponse) {
	w.mu.Lock()
	task, ok := w.pending[response.ID]
	if ok {
		delete(w.pending, response.ID)
	}
	w.mu.Unlock()
	if ok {
		task.response <- response
	}
}

// failAllPending 进程中断后拒绝全部在途请求。
func (w *sqliteWorker) failAllPending() {
	w.mu.Lock()
	tasks := make([]*pendingTask, 0, len(w.pending))
	for _, task := range w.pending {
		tasks = append(tasks, task)
	}
	w.pending = map[int64]*pendingTask{}
	w.mu.Unlock()
	for _, task := range tasks {
		task.response <- workerResponse{OK: boolPtr(false), Error: "SQLite 会话已中断"}
	}
}

// kill 幂等击杀子进程。
func (w *sqliteWorker) kill() {
	if w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
	}
}

// request 发一帧请求并等待应答；超时击杀子进程。
func (w *sqliteWorker) request(kind string, extra map[string]any, timeout time.Duration) (json.RawMessage, error) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil, errors.New("SQLite 会话已关闭")
	}
	w.sequence++
	id := w.sequence
	task := &pendingTask{response: make(chan workerResponse, 1)}
	w.pending[id] = task
	w.mu.Unlock()
	timer := time.AfterFunc(timeout, func() {
		w.mu.Lock()
		pending, ok := w.pending[id]
		if ok {
			delete(w.pending, id)
		}
		w.mu.Unlock()
		if ok {
			w.kill()
			pending.response <- workerResponse{OK: boolPtr(false), Error: "SQLite 操作超时，连接已中断"}
		}
	})
	defer timer.Stop()
	frame := map[string]any{"id": id, "kind": kind}
	for key, value := range extra {
		frame[key] = value
	}
	data, err := shared.MarshalJSON(frame)
	if err != nil {
		w.mu.Lock()
		delete(w.pending, id)
		w.mu.Unlock()
		return nil, err
	}
	if _, err := w.stdin.Write(append(data, '\n')); err != nil {
		w.mu.Lock()
		if _, ok := w.pending[id]; ok {
			delete(w.pending, id)
		} else {
			// 应答已由读循环派发，取回后按失败语义返回。
			w.mu.Unlock()
			<-task.response
		}
		w.mu.Unlock()
		timer.Stop()
		return nil, errors.New("SQLite 会话已中断")
	}
	response := <-task.response
	if response.OK == nil || !*response.OK {
		return nil, errors.New(response.Error)
	}
	return response.Value, nil
}

// close 击杀子进程并等待退出。
func (w *sqliteWorker) close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		<-w.exited
		return
	}
	w.closed = true
	w.mu.Unlock()
	w.kill()
	select {
	case <-w.exited:
	case <-time.After(5 * time.Second):
	}
}

// Worker 父进程侧统一出口（一次性操作与会话共用）。
type Worker interface {
	Request(kind string, extra map[string]any, timeout time.Duration) (json.RawMessage, error)
	Close()
}

// Request 代理到 sqliteWorker。
func (w *sqliteWorker) Request(kind string, extra map[string]any, timeout time.Duration) (json.RawMessage, error) {
	return w.request(kind, extra, timeout)
}

// Close 代理到 sqliteWorker。
func (w *sqliteWorker) Close() { w.close() }
