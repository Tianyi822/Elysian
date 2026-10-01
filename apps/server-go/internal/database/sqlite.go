package database

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// SQLite 文件托管服务（sqliteService.ts 等价物）：创建/上传/下载快照/删除/核对/
// 终端会话；全部写操作与每次 execute 经全局串行队列（配额语义依赖串行时点重算）。

const (
	sqliteUploadLimit       = 256 * 1024 * 1024
	sqliteFileLimit         = 1024 * 1024 * 1024
	sqliteTotalLimitDefault = 4 * 1024 * 1024 * 1024
	sqliteExportConcurrency = 2
	sqliteMaxDatabases      = 32
)

var (
	sqliteNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	sqliteUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// sqliteHeader SQLite 3 文件魔数。
var sqliteHeader = []byte("SQLite format 3\x00")

// sqliteRecord 登记行（~/.Elysian/config/sqlite-databases.json）；键序对齐 TS 构造序。
type sqliteRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Origin    string `json:"origin"`
	State     string `json:"state"`
	CreatedAt string `json:"createdAt"`
	Error     string `json:"error,omitempty"`
}

// sqlite state / origin 取值。
const (
	sqliteStatePending  = "pending"
	sqliteStateActive   = "active"
	sqliteStateDeleting = "deleting"
	sqliteOriginCreated = "created"
	sqliteOriginUpload  = "uploaded"
)

// SqliteService 托管操作集。
type SqliteService interface {
	List(ctx context.Context) ([]sqliteInstance, error)
	Create(ctx context.Context, name any) (sqliteInstance, error)
	ImportFile(ctx context.Context, name string, body io.Reader, declaredLength int64, contentType string) (sqliteInstance, error)
	Download(ctx context.Context, id string) (sqliteSnapshot, error)
	Remove(ctx context.Context, id string) error
	Reconcile(ctx context.Context, id string) (sqliteInstance, bool, error)
	Forget(ctx context.Context, id string) error
	OpenSession(ctx context.Context, id string) (Session, error)
}

// sqliteSnapshot 一份导出快照；Cleanup 一次性删快照并释放并发名额。
type sqliteSnapshot struct {
	Path    string
	Name    string
	Bytes   int64
	Cleanup func()
}

// sqliteOptions 服务选项（生产 uid/gid 2001；测试注入更小配额与测试专用 worker 命令）。
type sqliteOptions struct {
	DataDir         string
	RegistryPath    string
	UID             *uint32
	GID             *uint32
	QueryTimeout    time.Duration
	TotalLimitBytes int64
	Launcher        func() sqliteWorkerCommand
	Now             func() time.Time
}

// sqliteService 实现。
type sqliteService struct {
	options       sqliteOptions
	totalLimit    int64
	active        map[string]map[*sqliteWorker]bool
	activeMu      sync.Mutex
	activeExports int
	exportsMu     sync.Mutex
	serialize     sync.Mutex
}

// newSqliteService 构造托管服务。
func newSqliteService(options sqliteOptions) *sqliteService {
	if options.DataDir == "" {
		options.DataDir = filepath.Join(paths.DataDir, "sqlite")
	}
	if options.RegistryPath == "" {
		options.RegistryPath = filepath.Join(paths.ConfigDir, "sqlite-databases.json")
	}
	if options.TotalLimitBytes <= 0 {
		options.TotalLimitBytes = sqliteTotalLimitDefault
	}
	if options.QueryTimeout <= 0 {
		options.QueryTimeout = 15 * time.Second
	}
	if options.Launcher == nil {
		options.Launcher = defaultWorkerCommand
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &sqliteService{
		options:    options,
		totalLimit: options.TotalLimitBytes,
		active:     map[string]map[*sqliteWorker]bool{},
	}
}

// sqliteErr 域内 4xx 错误便捷构造。
func sqliteErr(status int, message string) error {
	return &shared.InvalidRequestError{Status: status, Message: message}
}

// validSqliteName 校验托管库名。
func validSqliteName(value any) (string, error) {
	name, ok := value.(string)
	if !ok || !sqliteNamePattern.MatchString(name) || name == "." || name == ".." {
		return "", sqliteErr(400, "SQLite 数据库名无效")
	}
	return name, nil
}

// ---------- fs 错误收敛（§6.3） ----------

// sqliteFSMessages errno code → 分类中文。
var sqliteFSMessages = map[string]string{
	"ENOENT":       "SQLite 管理文件不存在",
	"EACCES":       "SQLite 管理文件无法访问",
	"EPERM":        "SQLite 管理文件无法访问",
	"ENOTDIR":      "SQLite 管理路径类型无效",
	"EISDIR":       "SQLite 管理路径类型无效",
	"ENOSPC":       "SQLite 管理空间不足",
	"EDQUOT":       "SQLite 管理空间不足",
	"EROFS":        "SQLite 管理目录只读",
	"ELOOP":        "SQLite 管理路径嵌套超限",
	"ENAMETOOLONG": "SQLite 管理路径超长",
	"EIO":          "SQLite 管理存储读写失败",
	"EMFILE":       "SQLite 管理文件句柄不足",
	"ENFILE":       "SQLite 管理文件句柄不足",
}

// errnoError 携带 fs errno 名的错误（worker IPC 回传）。
type errnoError struct {
	code    string
	message string
}

func (e *errnoError) Error() string { return e.message }

// fsErrorCode 提取错误携带的 errno 名（IPC errnoError 或本进程 syscall 错误）。
func fsErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var tagged *errnoError
	if errors.As(err, &tagged) {
		return tagged.code
	}
	return errnoCode(err)
}

// sqliteFsMessage 把底层 fs 错误收敛为分类中文：只认 errno code、绝不读 message。
func sqliteFsMessage(err error) string {
	if err == nil {
		return "SQLite 管理文件不可用"
	}
	code := fsErrorCode(err)
	if code == "" {
		return err.Error()
	}
	if message, ok := sqliteFSMessages[code]; ok {
		return message
	}
	return "SQLite 管理文件不可用"
}

// rewrapFsError 源头收敛：带 errno 的错误整体替换为分类消息，其余原样上抛。
func rewrapFsError(err error) error {
	if err == nil {
		return nil
	}
	if fsErrorCode(err) != "" {
		return errors.New(sqliteFsMessage(err))
	}
	return err
}

// ---------- 目录与文件安全 ----------

// directory 数据目录（0700，realpath 锚定，生产 chown 2001）。
func (s *sqliteService) directory() (string, error) {
	if err := os.MkdirAll(s.options.DataDir, 0o700); err != nil {
		return "", rewrapFsError(err)
	}
	folder, err := filepath.EvalSymlinks(s.options.DataDir)
	if err != nil {
		return "", rewrapFsError(err)
	}
	info, err := os.Lstat(folder)
	if err != nil {
		return "", rewrapFsError(err)
	}
	if !info.IsDir() {
		return "", errors.New("SQLite 管理目录无效")
	}
	if err := os.Chmod(folder, 0o700); err != nil {
		return "", rewrapFsError(err)
	}
	if s.options.UID != nil && s.options.GID != nil {
		if err := os.Chown(folder, int(*s.options.UID), int(*s.options.GID)); err != nil {
			return "", rewrapFsError(err)
		}
	}
	return folder, nil
}

// records 读取并校验登记文件。
func (s *sqliteService) records() ([]sqliteRecord, error) {
	handle, err := openNoFollow(s.options.RegistryPath)
	if err != nil {
		if isNoEntry(err) {
			return nil, nil
		}
		return nil, rewrapFsError(err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return nil, rewrapFsError(err)
	}
	if !info.Mode().IsRegular() || info.Size() > 1024*1024 || info.Mode()&0o077 != 0 || uidOf(info) != os.Getuid() {
		return nil, errors.New("SQLite 登记文件权限无效")
	}
	var parsed []sqliteRecord
	if err := json.NewDecoder(handle).Decode(&parsed); err != nil || parsed == nil {
		return nil, errors.New("SQLite 登记内容无效")
	}
	for _, row := range parsed {
		if !sqliteUUIDPattern.MatchString(row.ID) || !sqliteNamePattern.MatchString(row.Name) ||
			(row.State != sqliteStatePending && row.State != sqliteStateActive && row.State != sqliteStateDeleting) {
			return nil, errors.New("SQLite 登记内容无效")
		}
	}
	return parsed, nil
}

// save 原子写登记。
func (s *sqliteService) save(rows []sqliteRecord) error {
	if rows == nil {
		rows = []sqliteRecord{}
	}
	data, err := shared.MarshalJSON(rows)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(s.options.RegistryPath, data); err != nil {
		return rewrapFsError(err)
	}
	return nil
}

// pathFor 登记行对应的数据文件路径。
func (s *sqliteService) pathFor(id string) (string, error) {
	if !sqliteUUIDPattern.MatchString(id) {
		return "", sqliteErr(404, "SQLite 数据库不存在")
	}
	directory, err := s.directory()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, id+".db"), nil
}

// checkedFile 受管文件的权限、类型与位置复验（防换链写穿）。
func (s *sqliteService) checkedFile(id string) (string, error) {
	path, err := s.pathFor(id)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", rewrapFsError(err)
	}
	directory, err := s.directory()
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", rewrapFsError(err)
	}
	if !info.Mode().IsRegular() || nlinkOf(info) != 1 || info.Size() > sqliteFileLimit ||
		info.Mode()&0o077 != 0 ||
		(s.options.UID != nil && uint32(uidOf(info)) != *s.options.UID) ||
		filepath.Dir(real) != directory {
		return "", errors.New("SQLite 文件权限、类型或位置无效")
	}
	return path, nil
}

// ownFile 收紧属主与权限。
func (s *sqliteService) ownFile(path string) error {
	if err := os.Chmod(path, 0o600); err != nil {
		return rewrapFsError(err)
	}
	if s.options.UID != nil && s.options.GID != nil {
		if err := os.Chown(path, int(*s.options.UID), int(*s.options.GID)); err != nil {
			return rewrapFsError(err)
		}
	}
	return nil
}

// spawnWorker 按服务选项启动一个 worker。
func (s *sqliteService) spawnWorker(file string, create bool) (*sqliteWorker, error) {
	return spawnSqliteWorker(file, create, s.options.Launcher())
}

// oneShot 一次性 worker 操作。
func (s *sqliteService) oneShot(path string, kind string, extra map[string]any, create bool, timeout time.Duration) (json.RawMessage, error) {
	worker, err := s.spawnWorker(path, create)
	if err != nil {
		return nil, rewrapFsError(err)
	}
	value, err := worker.request(kind, extra, timeout)
	worker.close()
	if err != nil {
		return nil, rewrapFsError(err)
	}
	return value, nil
}

// get 取登记行。
func (s *sqliteService) get(id string) (sqliteRecord, error) {
	rows, err := s.records()
	if err != nil {
		return sqliteRecord{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return sqliteRecord{}, sqliteErr(404, "SQLite 数据库不存在")
}

// probeSample probe 应答的解析目标。
type probeSample struct {
	TableCount int64  `json:"tableCount"`
	Version    string `json:"version"`
	Bytes      int64  `json:"bytes"`
}

// project 登记行 → 视图投影。
func (s *sqliteService) project(row sqliteRecord) (sqliteInstance, error) {
	status := statusRunning
	metricsError := row.Error
	var fileSizeMB *float64
	var tableCount *int
	version := "SQLite"
	var lastWrittenAt string
	filePath, err := s.pathFor(row.ID)
	if err != nil {
		return sqliteInstance{}, err
	}
	func() {
		checked, err := s.checkedFile(row.ID)
		if err != nil {
			status = statusStopped
			metricsError = sqliteFsMessage(err)
			return
		}
		info, statErr := os.Stat(checked)
		if statErr != nil {
			status = statusStopped
			metricsError = sqliteFsMessage(rewrapFsError(statErr))
			return
		}
		raw, probeErr := s.oneShot(checked, "probe", nil, false, 15*time.Second)
		if probeErr != nil {
			status = statusStopped
			metricsError = sqliteFsMessage(probeErr)
			return
		}
		var sample probeSample
		if json.Unmarshal(raw, &sample) != nil || sample.Version == "" {
			status = statusStopped
			metricsError = "SQLite 管理文件不可用"
			return
		}
		sizeMB := float64(info.Size()) / (1024 * 1024)
		tables := int(sample.TableCount)
		fileSizeMB = &sizeMB
		tableCount = &tables
		version = sample.Version
		lastWrittenAt = info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z")
	}()
	if row.State != sqliteStateActive {
		status = statusWarning
		if row.Error == "" {
			metricsError = "SQLite 文件操作尚未完成，请重新核对或清理登记"
		} else {
			metricsError = row.Error
		}
	}
	updatedAt := lastWrittenAt
	if updatedAt == "" {
		updatedAt = row.CreatedAt
	}
	return sqliteInstance{
		ID: "sqlite-" + row.ID, Engine: engineSQLite, Name: row.Name, Version: version, Status: status,
		FilePath: filePath, FileSizeMB: fileSizeMB, TableCount: tableCount, LastWrittenAt: lastWrittenAt,
		UpdatedAt: updatedAt, Source: sourceManaged, MetricsError: metricsError,
		NeedsAttention: row.State != sqliteStateActive || status != statusRunning,
	}, nil
}

// reserve 落一条 pending 登记。
func (s *sqliteService) reserve(name string, origin string) (sqliteRecord, error) {
	rows, err := s.records()
	if err != nil {
		return sqliteRecord{}, err
	}
	if len(rows) >= sqliteMaxDatabases {
		return sqliteRecord{}, sqliteErr(413, "SQLite 数据库数量已达 32 个上限")
	}
	for _, row := range rows {
		if strings.EqualFold(row.Name, name) {
			return sqliteRecord{}, sqliteErr(409, "同名 SQLite 数据库已存在")
		}
	}
	row := sqliteRecord{ID: newUUID(), Name: name, Origin: origin, State: sqliteStatePending, CreatedAt: isoNow(s.options.Now)}
	if err := s.save(append(rows, row)); err != nil {
		return sqliteRecord{}, err
	}
	return row, nil
}

// change 替换登记行。
func (s *sqliteService) change(row sqliteRecord) error {
	rows, err := s.records()
	if err != nil {
		return err
	}
	for i, item := range rows {
		if item.ID == row.ID {
			rows[i] = row
			break
		}
	}
	return s.save(rows)
}

// dropFromRegistry 删除登记行。
func (s *sqliteService) dropFromRegistry(id string) error {
	rows, err := s.records()
	if err != nil {
		return err
	}
	kept := make([]sqliteRecord, 0, len(rows))
	for _, item := range rows {
		if item.ID != id {
			kept = append(kept, item)
		}
	}
	return s.save(kept)
}

// totalBytes 受管空间总量（含 .upload staging）。
func (s *sqliteService) totalBytes() (int64, error) {
	rows, err := s.records()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, row := range rows {
		file, err := s.pathFor(row.ID)
		if err != nil {
			return 0, err
		}
		for _, path := range []string{file, file + ".upload"} {
			if info, err := os.Lstat(path); err == nil {
				total += info.Size()
			}
		}
	}
	return total, nil
}

// removeFiles 删除受管文件及其伴生文件；每项须普通文件且 nlink==1。
func (s *sqliteService) removeFiles(id string) error {
	file, err := s.pathFor(id)
	if err != nil {
		return err
	}
	for _, path := range []string{file, file + "-journal", file + "-wal", file + "-shm", file + ".upload"} {
		info, err := os.Lstat(path)
		if err != nil {
			if isNoEntry(err) {
				continue
			}
			return rewrapFsError(err)
		}
		if !info.Mode().IsRegular() || nlinkOf(info) != 1 {
			return errors.New("SQLite 文件类型无效，无法自动删除")
		}
		if err := os.Remove(path); err != nil && !isNoEntry(err) {
			return rewrapFsError(err)
		}
	}
	return nil
}

// validateHeader 校验上传文件头（SQLite 魔数与 WAL 拒收）。
func validateHeader(path string) error {
	handle, err := openNoFollow(path)
	if err != nil {
		return rewrapFsError(err)
	}
	defer handle.Close()
	header := make([]byte, 20)
	if _, err := io.ReadFull(handle, header); err != nil {
		return rewrapFsError(err)
	}
	if string(header[:len(sqliteHeader)]) != string(sqliteHeader) {
		return sqliteErr(400, "上传文件不是 SQLite 数据库")
	}
	if header[18] == 2 || header[19] == 2 {
		return sqliteErr(400, "WAL 数据库请先导出独立快照再上传")
	}
	return nil
}

// closeActive 关闭某 id 的全部活跃 worker。
func (s *sqliteService) closeActive(id string) {
	s.activeMu.Lock()
	workers := s.active[id]
	delete(s.active, id)
	s.activeMu.Unlock()
	for worker := range workers {
		worker.close()
	}
}

// List 全部托管库投影。
func (s *sqliteService) List(ctx context.Context) ([]sqliteInstance, error) {
	rows, err := s.records()
	if err != nil {
		return nil, err
	}
	instances := make([]sqliteInstance, 0, len(rows))
	for _, row := range rows {
		instance, err := s.project(row)
		if err != nil {
			return nil, err
		}
		instances = append(instances, instance)
	}
	return instances, nil
}

// Create 新建空库。
func (s *sqliteService) Create(ctx context.Context, name any) (sqliteInstance, error) {
	s.serialize.Lock()
	defer s.serialize.Unlock()
	used, err := s.totalBytes()
	if err != nil {
		return sqliteInstance{}, err
	}
	if used >= s.totalLimit {
		return sqliteInstance{}, sqliteErr(413, "SQLite 托管空间已达 4 GiB 上限")
	}
	validName, err := validSqliteName(name)
	if err != nil {
		return sqliteInstance{}, err
	}
	row, err := s.reserve(validName, sqliteOriginCreated)
	if err != nil {
		return sqliteInstance{}, err
	}
	return s.createBody(row)
}

// createBody 建库主体；任何失败登记留 error 后原样上抛。
func (s *sqliteService) createBody(row sqliteRecord) (instance sqliteInstance, err error) {
	defer func() {
		if err != nil {
			row.Error = sqliteFsMessage(err)
			_ = s.change(row)
		}
	}()
	file, err := s.pathFor(row.ID)
	if err != nil {
		return sqliteInstance{}, err
	}
	handle, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return sqliteInstance{}, rewrapFsError(err)
	}
	handle.Close()
	if err = s.ownFile(file); err != nil {
		return sqliteInstance{}, err
	}
	if _, err = s.oneShot(file, "init", nil, true, 15*time.Second); err != nil {
		return sqliteInstance{}, err
	}
	var used int64
	if used, err = s.totalBytes(); err != nil {
		return sqliteInstance{}, err
	}
	if used > s.totalLimit {
		_ = s.removeFiles(row.ID)
		return sqliteInstance{}, sqliteErr(413, "SQLite 托管空间超过 4 GiB")
	}
	row.State = sqliteStateActive
	if err = s.change(row); err != nil {
		return sqliteInstance{}, err
	}
	return s.project(row)
}

// ImportFile 上传导入（流式限额 → 头校验 → validate → 晋升正式文件）。
func (s *sqliteService) ImportFile(ctx context.Context, name string, body io.Reader, declaredLength int64, contentType string) (sqliteInstance, error) {
	s.serialize.Lock()
	defer s.serialize.Unlock()
	validName, err := validSqliteName(name)
	if err != nil {
		return sqliteInstance{}, err
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "application/octet-stream") {
		return sqliteInstance{}, sqliteErr(415, "上传类型必须为 application/octet-stream")
	}
	if declaredLength > 0 && declaredLength > sqliteUploadLimit {
		return sqliteInstance{}, sqliteErr(413, "SQLite 文件超过 256 MiB")
	}
	if body == nil {
		return sqliteInstance{}, sqliteErr(400, "上传文件不能为空")
	}
	used, err := s.totalBytes()
	if err != nil {
		return sqliteInstance{}, err
	}
	declaredExtra := int64(0)
	if declaredLength > 0 {
		declaredExtra = declaredLength
	}
	if used+declaredExtra > s.totalLimit {
		return sqliteInstance{}, sqliteErr(413, "SQLite 托管空间超过 4 GiB")
	}
	baseline := used
	row, err := s.reserve(validName, sqliteOriginUpload)
	if err != nil {
		return sqliteInstance{}, err
	}
	return s.importBody(row, body, baseline, declaredLength)
}

// importBody 上传主体；任何失败关句柄、删 staging、登记留 error 后上抛。
func (s *sqliteService) importBody(row sqliteRecord, body io.Reader, baseline, declaredLength int64) (instance sqliteInstance, err error) {
	var staging string
	defer func() {
		if err != nil {
			row.Error = sqliteFsMessage(err)
			_ = s.change(row)
		}
	}()
	file, err := s.pathFor(row.ID)
	if err != nil {
		return sqliteInstance{}, err
	}
	staging = file + ".upload"
	fail := func(cause error) (sqliteInstance, error) {
		os.Remove(staging)
		return sqliteInstance{}, cause
	}
	handle, err := os.OpenFile(staging, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		staging = ""
		return sqliteInstance{}, rewrapFsError(err)
	}
	var bytes int64
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			bytes += int64(n)
			if bytes > sqliteUploadLimit || bytes > sqliteFileLimit || baseline+bytes > s.totalLimit {
				handle.Close()
				return fail(sqliteErr(413, "SQLite 上传超过空间上限"))
			}
			if _, writeErr := handle.Write(buffer[:n]); writeErr != nil {
				handle.Close()
				return fail(rewrapFsError(writeErr))
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			handle.Close()
			return fail(readErr)
		}
	}
	if err = handle.Sync(); err != nil {
		handle.Close()
		return fail(rewrapFsError(err))
	}
	if err = handle.Close(); err != nil {
		return fail(rewrapFsError(err))
	}
	if bytes < 100 || (declaredLength > 0 && declaredLength != bytes) {
		return fail(sqliteErr(400, "SQLite 文件为空或上传不完整"))
	}
	if err = validateHeader(staging); err != nil {
		return fail(err)
	}
	if err = s.ownFile(staging); err != nil {
		return fail(err)
	}
	if _, err = s.oneShot(staging, "validate", nil, false, 60*time.Second); err != nil {
		return fail(err)
	}
	if err = os.Rename(staging, file); err != nil {
		return fail(rewrapFsError(err))
	}
	row.State = sqliteStateActive
	row.Error = ""
	if err = s.change(row); err != nil {
		return sqliteInstance{}, err
	}
	return s.project(row)
}

// Download 导出一致性快照；并发准入先于一切校验。
func (s *sqliteService) Download(ctx context.Context, id string) (sqliteSnapshot, error) {
	s.exportsMu.Lock()
	if s.activeExports >= sqliteExportConcurrency {
		s.exportsMu.Unlock()
		return sqliteSnapshot{}, sqliteErr(503, "SQLite 快照导出并发已达上限，请稍后重试")
	}
	s.activeExports++
	s.exportsMu.Unlock()
	settled := false
	var targetRef *string
	settle := func() {
		if settled {
			return
		}
		settled = true
		s.exportsMu.Lock()
		s.activeExports--
		s.exportsMu.Unlock()
		if targetRef != nil {
			os.Remove(*targetRef)
		}
	}
	handedOff := false
	defer func() {
		// 失败路径兜底释放；成功路径已交接给 cleanup，一次性 flag 保证不重复递减。
		if !handedOff {
			settle()
		}
	}()
	row, err := s.get(id)
	if err != nil {
		return sqliteSnapshot{}, err
	}
	if row.State != sqliteStateActive {
		return sqliteSnapshot{}, sqliteErr(409, "SQLite 文件尚未就绪")
	}
	file, err := s.checkedFile(id)
	if err != nil {
		return sqliteSnapshot{}, err
	}
	directory, err := s.directory()
	if err != nil {
		return sqliteSnapshot{}, err
	}
	target := filepath.Join(directory, "."+id+"."+newUUID()+".export")
	targetRef = &target
	raw, err := s.oneShot(file, "export", map[string]any{"target": target}, false, 60*time.Second)
	if err != nil {
		return sqliteSnapshot{}, err
	}
	var exportResult struct {
		Bytes int64 `json:"bytes"`
	}
	_ = json.Unmarshal(raw, &exportResult)
	// 成功：释放名额的责任移交给返回的 cleanup（快照存活期间占住名额）。
	handedOff = true
	return sqliteSnapshot{
		Path: target, Name: row.Name + ".db", Bytes: exportResult.Bytes,
		Cleanup: func() { settle() },
	}, nil
}

// Remove 删除 SQLite 文件（可重试清理）。
func (s *sqliteService) Remove(ctx context.Context, id string) error {
	s.serialize.Lock()
	defer s.serialize.Unlock()
	row, err := s.get(id)
	if err != nil {
		return err
	}
	row.State = sqliteStateDeleting
	if err := s.change(row); err != nil {
		return err
	}
	s.closeActive(id)
	if err := s.removeFiles(id); err != nil {
		row.Error = err.Error()
		_ = s.change(row)
		return err
	}
	return s.dropFromRegistry(id)
}

// Reconcile 重新核对；deleting 态完成清理后返回空体（hasBody=false）。
func (s *sqliteService) Reconcile(ctx context.Context, id string) (instance sqliteInstance, hasBody bool, err error) {
	s.serialize.Lock()
	defer s.serialize.Unlock()
	row, err := s.get(id)
	if err != nil {
		return sqliteInstance{}, false, err
	}
	if row.State == sqliteStateDeleting {
		if err := s.removeFiles(id); err != nil {
			return sqliteInstance{}, false, err
		}
		if err := s.dropFromRegistry(id); err != nil {
			return sqliteInstance{}, false, err
		}
		return sqliteInstance{}, false, nil
	}
	return s.reconcileBody(row, id)
}

// reconcileBody 核对主体；staging 晋升 → 复验 → 激活；失败置 pending 留分类 error。
func (s *sqliteService) reconcileBody(row sqliteRecord, id string) (instance sqliteInstance, hasBody bool, err error) {
	defer func() {
		if err != nil {
			row.State = sqliteStatePending
			row.Error = sqliteFsMessage(err)
			_ = s.change(row)
		}
	}()
	file, err := s.pathFor(id)
	if err != nil {
		return sqliteInstance{}, false, err
	}
	staging := file + ".upload"
	if _, statErr := os.Lstat(file); statErr != nil {
		if !isNoEntry(statErr) {
			return sqliteInstance{}, false, rewrapFsError(statErr)
		}
		if err = validateHeader(staging); err != nil {
			return sqliteInstance{}, false, err
		}
		if err = s.ownFile(staging); err != nil {
			return sqliteInstance{}, false, err
		}
		if _, err = s.oneShot(staging, "validate", nil, false, 60*time.Second); err != nil {
			return sqliteInstance{}, false, err
		}
		if err = os.Rename(staging, file); err != nil {
			return sqliteInstance{}, false, rewrapFsError(err)
		}
	}
	checked, err := s.checkedFile(id)
	if err != nil {
		return sqliteInstance{}, false, err
	}
	if _, err = s.oneShot(checked, "validate", nil, false, 60*time.Second); err != nil {
		return sqliteInstance{}, false, err
	}
	row.State = sqliteStateActive
	row.Error = ""
	if err = s.change(row); err != nil {
		return sqliteInstance{}, false, err
	}
	instance, err = s.project(row)
	if err != nil {
		return sqliteInstance{}, false, err
	}
	return instance, true, nil
}

// Forget 清理待处理登记；active 且 running 的库必须先删文件。
func (s *sqliteService) Forget(ctx context.Context, id string) error {
	s.serialize.Lock()
	defer s.serialize.Unlock()
	row, err := s.get(id)
	if err != nil {
		return err
	}
	if row.State == sqliteStateActive {
		instance, err := s.project(row)
		if err != nil {
			return err
		}
		if instance.Status == statusRunning {
			return sqliteErr(409, "必须先删除 SQLite 文件")
		}
	}
	if err := s.removeFiles(id); err != nil {
		return err
	}
	return s.dropFromRegistry(id)
}

// sqliteSessionHandle 一个 SQLite 终端会话。
type sqliteSessionHandle struct {
	service *sqliteService
	worker  *sqliteWorker
	id      string
}

// OpenSession 打开 SQLite 终端会话（独立 worker 子进程）。
func (s *sqliteService) OpenSession(ctx context.Context, id string) (Session, error) {
	row, err := s.get(id)
	if err != nil {
		return nil, err
	}
	if row.State != sqliteStateActive {
		return nil, sqliteErr(409, "SQLite 文件尚未就绪")
	}
	file, err := s.checkedFile(id)
	if err != nil {
		return nil, err
	}
	worker, err := s.spawnWorker(file, false)
	if err != nil {
		return nil, err
	}
	s.activeMu.Lock()
	set := s.active[id]
	if set == nil {
		set = map[*sqliteWorker]bool{}
		s.active[id] = set
	}
	set[worker] = true
	s.activeMu.Unlock()
	return &sqliteSessionHandle{service: s, worker: worker, id: id}, nil
}

// Execute 按会话配额执行 SQL（全局串行，配额在串行时点重算）。
func (h *sqliteSessionHandle) Execute(ctx context.Context, input string) ([]string, error) {
	h.service.serialize.Lock()
	defer h.service.serialize.Unlock()
	file, err := h.service.checkedFile(h.id)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(file)
	if err != nil {
		return nil, rewrapFsError(err)
	}
	ownBytes := info.Size()
	total, err := h.service.totalBytes()
	if err != nil {
		return nil, err
	}
	others := total - ownBytes
	room := int64(sqliteFileLimit)
	if h.service.totalLimit-others < room {
		room = h.service.totalLimit - others
	}
	limitBytes := ownBytes
	if room > limitBytes {
		limitBytes = room
	}
	raw, err := h.worker.request("execute", map[string]any{"sql": input, "limitBytes": limitBytes}, h.service.options.QueryTimeout)
	if err != nil {
		return nil, err
	}
	var lines []string
	if err := json.Unmarshal(raw, &lines); err != nil {
		return nil, err
	}
	return lines, nil
}

// Close 关闭会话 worker。
func (h *sqliteSessionHandle) Close() error {
	h.worker.close()
	h.service.activeMu.Lock()
	if set := h.service.active[h.id]; set != nil {
		delete(set, h.worker)
	}
	h.service.activeMu.Unlock()
	return nil
}
