package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"

	"elysian/server/internal/agent/harness/sessionstore"
)

type Inspector struct{}

var _ sessionstore.Inspector = Inspector{}

func (Inspector) PreserveFacts(ctx context.Context, path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, sidecarErr := os.Lstat(path + suffix); sidecarErr == nil || !os.IsNotExist(sidecarErr) {
				return false, fmt.Errorf("运行数据库缺失但仍有相关文件，无法确认未决执行屏障，已拒绝恢复")
			}
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("无法读取运行数据库，已拒绝恢复：%w", err)
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("运行数据库不是普通文件，无法确认未决执行屏障，已拒绝恢复")
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return false, fmt.Errorf("无法打开运行数据库，已拒绝恢复：%w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return false, fmt.Errorf("无法确认运行数据库版本，已拒绝恢复：%w", err)
	}
	if version < 1 {
		return false, fmt.Errorf("运行数据库版本无效，已拒绝恢复")
	}
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return false, fmt.Errorf("运行数据库完整性检查未通过，已拒绝恢复")
	}
	var hasTable bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='execution_barriers')").Scan(&hasTable); err != nil {
		return false, fmt.Errorf("无法确认执行屏障表，已拒绝恢复：%w", err)
	}
	if !hasTable {
		if version == 1 || version == 2 {
			return false, nil
		}
		return false, fmt.Errorf("运行数据库缺少执行屏障表，无法确认未决执行，已拒绝恢复")
	}
	var pending bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM execution_barriers WHERE state IN ('dispatched','unknown'))").Scan(&pending); err != nil {
		return false, fmt.Errorf("无法读取未决执行屏障，已拒绝恢复：%w", err)
	}
	if version >= 5 {
		var pendingLease bool
		if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM resource_leases WHERE state IN ('held','unknown'))").Scan(&pendingLease); err != nil {
			return false, fmt.Errorf("无法核实运行数据库中的资源租约，已拒绝恢复：%w", err)
		}
		pending = pending || pendingLease
	}
	return pending, nil
}

func (Inspector) ActiveRuns(ctx context.Context, path string) (int, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行")
	}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return 0, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var exists bool
	if err = db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='runs')").Scan(&exists); err != nil {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行：%w", err)
	}
	if !exists {
		return 0, nil
	}
	var n int
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted') AND json_extract(document,'$.sessionId') IS NOT NULL AND json_extract(document,'$.sessionId') != ''").Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("无法只读核对 Agent 活动运行：%w", err)
	}
	return n, nil
}
