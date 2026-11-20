package database

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"time"

	"elysian/server/internal/atomicfile"
	"elysian/server/internal/shared"
)

var (
	sqliteNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	sqliteUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

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

// validSqliteName 校验托管库名。
func validSqliteName(value any) (string, error) {
	name, ok := value.(string)
	if !ok || !sqliteNamePattern.MatchString(name) || name == "." || name == ".." {
		return "", sqliteErr(400, "SQLite 数据库名无效")
	}
	return name, nil
}

// records 读取并校验登记文件。
func (s *sqliteService) records() ([]sqliteRecord, error) {
	handle, err := atomicfile.OpenNoFollow(s.options.RegistryPath)
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
	if !statRegistryFile(info) {
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
