package database

import (
	"context"
	"errors"
	"os"
	"time"
)

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
