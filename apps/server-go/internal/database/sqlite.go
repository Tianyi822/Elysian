package database

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"elysian/server/internal/atomicfile"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// SQLite 文件托管服务（sqliteService.ts 等价物）：创建/上传/下载快照/删除/核对；
// 全部写操作经全局串行队列。SQL 会话已随数据库终端退役，仅保留文件操作。

const (
	sqliteUploadLimit       = 256 * 1024 * 1024
	sqliteFileLimit         = 1024 * 1024 * 1024
	sqliteTotalLimitDefault = 4 * 1024 * 1024 * 1024
	sqliteExportConcurrency = 2
	sqliteMaxDatabases      = 32
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
}

// sqliteOptions 服务选项（生产 uid/gid 2001；测试注入更小配额与测试专用 worker 命令）。
type sqliteOptions struct {
	DataDir         string
	RegistryPath    string
	UID             *uint32
	GID             *uint32
	TotalLimitBytes int64
	Launcher        func() sqliteWorkerCommand
	Now             func() time.Time
}

// sqliteService 实现。
type sqliteService struct {
	options       sqliteOptions
	totalLimit    int64
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
	if options.Launcher == nil {
		options.Launcher = defaultWorkerCommand
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &sqliteService{
		options:    options,
		totalLimit: options.TotalLimitBytes,
	}
}

// sqliteErr 域内 4xx 错误便捷构造。
func sqliteErr(status int, message string) error {
	return &shared.InvalidRequestError{Status: status, Message: message}
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
	policy := atomicfile.TrustOptions{MaxBytes: sqliteFileLimit, RejectPerm: 0o077, OwnerUID: s.options.UID, SingleLink: true}
	if !atomicfile.StatTrusted(info, policy) || filepath.Dir(real) != directory {
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
