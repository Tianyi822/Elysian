package sqlite

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"elysian/server/internal/agent/harness/state"
)

// An absent database is not a fresh installation when durable records survive.
// Never create a replacement database over the evidence needed for recovery.
func checkStoreInitialization(path string) error {
	info, err := os.Lstat(path)
	if err == nil && (!info.Mode().IsRegular() || info.Size() != 0) {
		return nil // ordinary path validation below handles non-regular files
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(path + suffix); err == nil {
			return errors.New("运行数据库缺失或为空，但仍有数据库相关文件；已拒绝创建空库，请核实原数据目录和备份")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	root := filepath.Join(filepath.Dir(path), "agent-records")
	found := false
	err = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkErr error) error {
		if os.IsNotExist(walkErr) {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return err
	}
	if found {
		return errors.New("运行数据库缺失或为空，但历史 JSONL 记录仍在；已拒绝创建空库，请核实原数据目录和备份")
	}
	return nil
}

type recordIntegrityError struct{ message string }

func recordIntegrity(message string) error { return &recordIntegrityError{message} }

func (s *store) wakeRecordWorker() {
	if s.recordWake != nil {
		select {
		case s.recordWake <- struct{}{}:
		default:
		}
	}
}

// Production uses one file worker. SQLite/outbox commits return independently
// of slow file I/O; all external dispatch gates wait for their committed prefix.
func (s *store) startRecordWorker(notify func()) {
	s.recordAsync = true
	s.recordWake, s.recordStop, s.recordDone = make(chan struct{}, 1), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(s.recordDone)
		delays := []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second}
		attempt := 0
		for {
			s.recordsStateMu.RLock()
			permanent := s.recordsPermanent
			s.recordsStateMu.RUnlock()
			if !permanent {
				err := s.prepareRecords()
				if err == nil {
					err = s.reconcileRecords(false)
				}
				if err != nil {
					s.failRecords(err)
				} else {
					s.recordsStateMu.Lock()
					s.recordsErr = nil
					s.recordsStateMu.Unlock()
					attempt = 0
				}
				s.signalProgress()
				if notify != nil {
					notify()
				}
			}
			delay := delays[min(attempt, len(delays)-1)]
			if s.recordsFault() != nil {
				attempt++
			} else {
				delay = 30 * time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-s.recordStop:
				timer.Stop()
				return
			case <-s.recordWake:
				timer.Stop()
			case <-timer.C:
			}
		}
	}()
}

func (s *store) stopRecordWorker() {
	if s.recordStop == nil {
		return
	}
	close(s.recordStop)
	<-s.recordDone
	s.recordStop = nil
	// Shutdown preserves the outbox even if the final file synchronization fails.
	if s.recordsFault() == nil {
		if err := s.reconcileRecords(false); err != nil {
			s.failRecords(err)
		}
	}
}

func (s *store) waitRecords(ctx context.Context) error {
	var target int64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq),0) FROM agent_record_outbox").Scan(&target); err != nil {
		return err
	}
	return s.awaitRecords(ctx, target)
}

func (s *store) signalProgress() {
	s.progressMu.Lock()
	defer s.progressMu.Unlock()
	if s.progress != nil {
		close(s.progress)
	}
	s.progress = make(chan struct{})
}

func (s *store) awaitRecords(ctx context.Context, target int64) error {
	if !s.recordAsync {
		return s.recordsFault()
	}
	s.wakeRecordWorker()
	for {
		s.progressMu.Lock()
		if s.progress == nil {
			s.progress = make(chan struct{})
		}
		progress := s.progress
		s.progressMu.Unlock()
		if err := s.recordsFault(); err != nil {
			return fmt.Errorf("派发前记录同步未完成：%w", err)
		}
		pending, err := storeRead(ctx, s, "replica-watermark", func(ctx context.Context) (bool, error) {
			var pending bool
			err := s.reader(ctx).QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM agent_record_outbox o
 LEFT JOIN agent_record_watermarks w ON w.owner_kind=o.owner_kind AND w.owner_id=o.owner_id
 WHERE o.seq<=? AND o.seq>COALESCE(w.last_seq,0))`, target).Scan(&pending)
			return pending, err
		})
		if err != nil {
			return err
		}
		if !pending {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-progress:
		}
	}
}

func (s *store) health() StorageHealth {
	s.recordsStateMu.RLock()
	defer s.recordsStateMu.RUnlock()
	h := StorageHealth{Read: "ready", Write: "ready", Records: "ready"}
	if s.readErr != nil {
		h.Read = "unavailable"
	}
	if s.writeErr != nil {
		h.Write = "unavailable"
		h.Recovery = "verification-required"
	}
	if s.recordsErr != nil {
		h.Records = "unavailable"
		if s.recordsPermanent {
			h.Recovery = "verification-required"
		} else if h.Recovery == "" {
			h.Recovery = "retrying"
		}
	}
	return h
}

func (s *store) validateExistingDatabase() error {
	var result string
	if err := s.db.QueryRow("PRAGMA quick_check").Scan(&result); err != nil {
		return fmt.Errorf("运行数据库完整性检查失败：%w", err)
	}
	if result != "ok" {
		return errors.New("运行数据库完整性检查未通过，已保留文件并拒绝创建替代空库")
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='runs'").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		if err := s.db.QueryRow("SELECT COUNT(*) FROM runs").Scan(&count); err != nil {
			return err
		}
	}

	if count > 0 {
		return nil
	}
	for _, table := range []string{"agent_record_outbox", "agent_record_cleanup"} {
		var exists bool
		if err := s.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", table).Scan(&exists); err != nil {
			return err
		}
		if exists {
			if err := s.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
				return err
			}
			if count > 0 {
				return nil
			}
		}
	}
	found := false
	err := filepath.WalkDir(s.recordsRoot, func(_ string, e fs.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !e.IsDir() {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	if err != nil {
		return err
	}
	if found {
		return errors.New("运行数据库没有会话，但历史 JSONL 记录仍在，已暂停初始化以核实原数据库")
	}
	return nil
}

type StorageHealth = state.StorageHealth

func (e *recordIntegrityError) Error() string { return e.message }
