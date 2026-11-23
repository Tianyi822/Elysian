package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

type rebuildOwner struct {
	recordOwner
	oldDigest string
}

// Called under the store's exclusive lock, before the replica worker or any
// caller can append records. A committed upgrade can resume from SQLite alone.
func (s *store) migrateRetiredData() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version == 11 {
		if err := s.prepareRecords(); err != nil {
			return err
		}
		if err := s.reconcileRecords(true); err != nil {
			return err
		}
		if err := s.removeLegacyKnowledge(); err != nil {
			return err
		}
	}
	return s.rebuildRetiredRecords()
}

const retiredFacts = `fact_type IN ('wiki_session_spaces','wiki_run_spaces','wiki_recalls',
 'wiki_task_contexts','wiki_visible_pages','wiki_artifacts','wiki_dependencies','wiki_jobs')`

func (s *store) removeLegacyKnowledge() error {
	owners, err := s.recordOwners("SELECT DISTINCT owner_kind,owner_id FROM agent_record_outbox WHERE " + retiredFacts)
	if err != nil {
		return err
	}
	rebuilds := make([]rebuildOwner, 0, len(owners))
	for _, owner := range owners {
		path, err := s.recordPath(owner)
		if err != nil {
			return err
		}
		digest, found, err := recordFileDigest(path)
		if err != nil {
			return err
		}
		if !found {
			return recordIntegrity("已核验的记录文件丢失")
		}
		expected := sha256.New()
		if _, _, err = s.writeRecordSnapshot(owner, expected); err != nil {
			return err
		}
		if digest != hex.EncodeToString(expected.Sum(nil)) {
			return recordIntegrity("待迁移的记录文件与已提交的数据库事实不一致")
		}
		rebuilds = append(rebuilds, rebuildOwner{owner, digest})
	}

	ctx := context.Background()
	return s.writeTransaction(ctx, "retire-knowledge", false, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, retirementSchema+legacyContextExclusions); err != nil {
			return err
		}
		if err := s.stopLegacyRuns(ctx, tx); err != nil {
			return err
		}
		for _, rebuild := range rebuilds {
			if _, err := tx.ExecContext(ctx, "INSERT INTO agent_record_rebuild VALUES(?,?,?)", rebuild.kind, rebuild.id, rebuild.oldDigest); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM agent_record_outbox WHERE "+retiredFacts); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, retiredWikiTables+"PRAGMA user_version=12"); err != nil {
			return err
		}
		return nil
	})
}

func recordFileDigest(path string) (string, bool, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() {
		return "", false, recordIntegrity("待迁移的记录文件不是普通文件")
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, f); err != nil {
		return "", false, err
	}
	return hex.EncodeToString(digest.Sum(nil)), true, nil
}

func (s *store) rebuildRetiredRecords() error {
	rows, err := s.db.Query("SELECT owner_kind,owner_id,old_digest FROM agent_record_rebuild ORDER BY owner_kind,owner_id")
	if err != nil {
		return err
	}
	var rebuilds []rebuildOwner
	for rows.Next() {
		var r rebuildOwner
		if err = rows.Scan(&r.kind, &r.id, &r.oldDigest); err != nil {
			rows.Close()
			return err
		}
		rebuilds = append(rebuilds, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(rebuilds) > 0 {
		if err := s.prepareRecords(); err != nil {
			return err
		}
	}
	for _, r := range rebuilds {
		if err := s.rebuildRetiredOwner(r); err != nil {
			return fmt.Errorf("清理 %s %s 的独立知识流水: %w", r.kind, r.id, err)
		}
	}
	return nil
}

func (s *store) rebuildRetiredOwner(r rebuildOwner) error {
	path, err := s.recordPath(r.recordOwner)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".retirement-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	digest := sha256.New()
	seq, size, err := s.writeRecordSnapshot(r.recordOwner, io.MultiWriter(file, digest))
	if err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}

	actual, found, err := recordFileDigest(path)
	if err != nil {
		return err
	}
	switch {
	case size == 0 && !found, size != 0 && found && actual == hex.EncodeToString(digest.Sum(nil)):
		// A previous attempt already published the replacement.
	case !found || actual != r.oldDigest:
		return recordIntegrity("待迁移的记录文件与已核验内容不一致")
	case size == 0:
		if err := os.Remove(path); err != nil {
			return err
		}
	default:
		if err := os.Rename(file.Name(), path); err != nil {
			return err
		}
	}
	if err := syncRecordDir(filepath.Dir(path)); err != nil {
		return err
	}
	if err := s.recordStage("retirement-published"); err != nil {
		return err
	}
	return s.writeTransaction(context.Background(), "retired-replica-ack", false, func(tx *sql.Tx) error {
		if seq == 0 {
			if _, err := tx.Exec("DELETE FROM agent_record_watermarks WHERE owner_kind=? AND owner_id=?", r.kind, r.id); err != nil {
				return err
			}
		} else if _, err := tx.Exec(`INSERT INTO agent_record_watermarks VALUES(?,?,?,?)
 ON CONFLICT(owner_kind,owner_id) DO UPDATE SET last_seq=excluded.last_seq,file_bytes=excluded.file_bytes`, r.kind, r.id, seq, size); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM agent_record_dirty WHERE owner_kind=? AND owner_id=?", r.kind, r.id); err != nil {
			return err
		}
		_, err := tx.Exec("DELETE FROM agent_record_rebuild WHERE owner_kind=? AND owner_id=?", r.kind, r.id)
		return err
	})
}

func (s *store) writeRecordSnapshot(owner recordOwner, dst io.Writer) (seq, size int64, err error) {
	for {
		batch, err := s.recordBatch(owner, seq)
		if err != nil || len(batch) == 0 {
			return seq, size, err
		}
		for _, entry := range batch {
			line, err := encodeRecord(owner, entry)
			if err != nil {
				return seq, size, err
			}
			if _, err := dst.Write(line); err != nil {
				return seq, size, err
			}
			seq, size = entry.sequence, size+int64(len(line))
		}
	}
}
