package database

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elysian/server/internal/atomicfile"
)

// sqliteHeader SQLite 3 文件魔数。
var sqliteHeader = []byte("SQLite format 3\x00")

// sqliteSnapshot 一份导出快照；Cleanup 一次性删快照并释放并发名额。
type sqliteSnapshot struct {
	Path    string
	Name    string
	Bytes   int64
	Cleanup func()
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

// validateHeader 校验上传文件头（SQLite 魔数与 WAL 拒收）。
func validateHeader(path string) error {
	handle, err := atomicfile.OpenNoFollow(path)
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
