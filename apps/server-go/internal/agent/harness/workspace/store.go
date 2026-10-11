package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type Store struct {
	root   *os.File
	lock   *os.File
	limits Limits
	gate   chan struct{}
	closed bool
	// beforePublish 只用于同包测试注入发布前存储故障。
	beforePublish func() error
}

// Open 打开私有目录，采用目录描述符和跨进程锁。不会自动清理任何历史版本。
func Open(root string, options ...Options) (*Store, error) {
	if len(options) > 1 {
		return nil, problem(400, "workspace_invalid_options", "工作区只能提供一组配置")
	}
	var opts Options
	if len(options) == 1 {
		opts = options[0]
	}
	limits, err := normalizeLimits(opts.Limits)
	if err != nil {
		return nil, err
	}
	dir, err := openRoot(root)
	if err != nil {
		return nil, err
	}
	lock, err := safeFileAt(dir, ".lock", unix.O_RDWR|unix.O_CREAT)
	if err != nil {
		dir.Close()
		return nil, storageError(err)
	}
	return &Store{root: dir, lock: lock, limits: limits, gate: make(chan struct{}, 1)}, nil
}

func (s *Store) Close() error {
	s.gate <- struct{}{}
	defer func() { <-s.gate }()
	if s.closed {
		return nil
	}
	s.closed = true
	return errors.Join(s.lock.Close(), s.root.Close())
}

func (s *Store) acquire(ctx context.Context) (func(), error) {
	select {
	case s.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, contextError(ctx.Err())
	}
	unlockGate := func() { <-s.gate }
	if err := ctx.Err(); err != nil {
		unlockGate()
		return nil, contextError(err)
	}
	if s.closed {
		unlockGate()
		return nil, problem(503, "workspace_closed", "工作区存储已关闭")
	}
	// 锁文件被外部删除或替换时拒绝继续，避免多个进程使用不同锁。
	var actual, current unix.Stat_t
	if err := unix.Fstat(int(s.lock.Fd()), &actual); err != nil {
		unlockGate()
		return nil, storageError(err)
	}
	if err := unix.Fstatat(int(s.root.Fd()), ".lock", &current, unix.AT_SYMLINK_NOFOLLOW); err != nil || actual.Ino != current.Ino || actual.Dev != current.Dev || actual.Nlink != 1 {
		unlockGate()
		return nil, problem(409, "workspace_lock_changed", "工作区锁文件已变化，请重新打开存储")
	}
	for {
		err := unix.Flock(int(s.lock.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { unix.Flock(int(s.lock.Fd()), unix.LOCK_UN); unlockGate() }, nil
		}
		if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			unlockGate()
			return nil, storageError(err)
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			unlockGate()
			return nil, contextError(ctx.Err())
		case <-timer.C:
		}
	}
}

func contextError(err error) error {
	return &Error{Status: 408, Code: "workspace_canceled", Message: "工作区操作已取消或超时", cause: err}
}

func exposeError(err error) error {
	if err == nil {
		return nil
	}
	var p *Error
	if errors.As(err, &p) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return contextError(err)
	}
	return storageError(err)
}

func archiveName(taskID string, revision int) string {
	return fmt.Sprintf("%s.%d.tar", taskID, revision)
}

func (s *Store) temporary() (*os.File, string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", err
	}
	name := ".stage-" + hex.EncodeToString(random[:])
	f, err := safeFileAt(s.root, name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL)
	return f, name, err
}

func (s *Store) unlink(name string) error { return unix.Unlinkat(int(s.root.Fd()), name, 0) }

// usage 在持有跨进程锁时计算全部不可变归档的实际占用。未清理的临时文件也计入，
// 防止进程崩溃留下的暂存文件绕过全局配额。
func (s *Store) usage(taskID string) (int64, int, error) {
	fd, err := unix.Openat(int(s.root.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, 0, err
	}
	dir := os.NewFile(uintptr(fd), ".")
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return 0, 0, err
	}
	var bytes int64
	maxRevision := 0
	for _, entry := range entries {
		name := entry.Name()
		if name == ".lock" {
			continue
		}
		f, openErr := safeFileAt(s.root, name, unix.O_RDONLY)
		if openErr != nil {
			return 0, 0, openErr
		}
		info, statErr := f.Stat()
		f.Close()
		if statErr != nil {
			return 0, 0, statErr
		}
		if !strings.HasSuffix(name, ".tar") && !strings.HasPrefix(name, ".stage-") && !strings.HasSuffix(name, ".sequence") {
			return 0, 0, problem(409, "workspace_unexpected_file", "工作区根目录包含无法识别的文件")
		}
		if info.Size() > s.limits.GlobalBytes-bytes {
			return 0, 0, quotaError("工作区总存储已达到上限")
		}
		bytes += info.Size()
		if name == taskID+".sequence" {
			counter, openErr := safeFileAt(s.root, name, unix.O_RDONLY)
			if openErr != nil {
				return 0, 0, openErr
			}
			data, readErr := io.ReadAll(io.LimitReader(counter, 32))
			counter.Close()
			n, parseErr := strconv.Atoi(string(data))
			if readErr != nil || parseErr != nil || n < 1 {
				return 0, 0, problem(409, "workspace_invalid_sequence", "工作区版本计数无效")
			}
			if n > maxRevision {
				maxRevision = n
			}
		}
		if strings.HasPrefix(name, taskID+".") && strings.HasSuffix(name, ".tar") {
			n, parseErr := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, taskID+"."), ".tar"))
			if parseErr != nil || n < 1 {
				return 0, 0, problem(409, "workspace_invalid_archive", "工作区版本文件名无效")
			}
			if n > maxRevision {
				maxRevision = n
			}
		}
	}
	return bytes, maxRevision, nil
}

func (s *Store) Version(ctx context.Context, taskID string, revision int) (Version, error) {
	snapshot, err := s.List(ctx, taskID, revision)
	return snapshot.Version, err
}

func (s *Store) List(ctx context.Context, taskID string, revision int) (Snapshot, error) {
	if err := validateTask(taskID, revision); err != nil {
		return Snapshot{}, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	defer release()
	loaded, err := s.load(ctx, taskID, revision)
	if err != nil {
		return Snapshot{}, exposeError(err)
	}
	defer loaded.close()
	return loaded.snapshot(), nil
}

func (s *Store) Read(ctx context.Context, taskID string, revision int, name string) ([]byte, Version, error) {
	return s.read(ctx, taskID, revision, name, 0)
}

// ReadLimited 在 Read 之上增加单文件返回上限：超过 limit 字节的文件直接拒绝，
// 不把内容载入调用方内存。limit 必须为正数；0 表示不设限（等价于 Read）。
func (s *Store) ReadLimited(ctx context.Context, taskID string, revision int, name string, limit int64) ([]byte, Version, error) {
	return s.read(ctx, taskID, revision, name, limit)
}

func (s *Store) read(ctx context.Context, taskID string, revision int, name string, limit int64) ([]byte, Version, error) {
	if err := validateTask(taskID, revision); err != nil {
		return nil, Version{}, err
	}
	if err := validatePath(name); err != nil {
		return nil, Version{}, err
	}
	if limit < 0 {
		return nil, Version{}, problem(400, "workspace_invalid_limit", "工作区单文件读取上限必须为非负数")
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return nil, Version{}, err
	}
	defer release()
	loaded, err := s.load(ctx, taskID, revision)
	if err != nil {
		return nil, Version{}, exposeError(err)
	}
	defer loaded.close()
	for _, entry := range loaded.entries {
		if entry.Path == name {
			if limit > 0 && entry.Size > limit {
				return nil, loaded.version, quotaError("工作区文件超过单次读取上限")
			}
			var reader io.Reader = &contextReader{ctx: ctx, r: entry.reader()}
			if limit > 0 {
				reader = io.LimitReader(reader, limit+1)
			}
			data, readErr := io.ReadAll(reader)
			if readErr == nil && limit > 0 && int64(len(data)) > limit {
				return nil, loaded.version, quotaError("工作区文件超过单次读取上限")
			}
			return data, loaded.version, exposeError(readErr)
		}
	}
	return nil, loaded.version, problem(404, "workspace_file_not_found", "工作区文件不存在")
}

// Export 输出没有内部元数据的 TAR；目录由文件路径表示，不保留空目录。
func (s *Store) Export(ctx context.Context, taskID string, revision int, w io.Writer) (Version, error) {
	if err := validateTask(taskID, revision); err != nil {
		return Version{}, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return Version{}, err
	}
	defer release()
	loaded, err := s.load(ctx, taskID, revision)
	if err != nil {
		return Version{}, exposeError(err)
	}
	defer loaded.close()
	err = writeArchive(ctx, w, loaded.entries, nil)
	return loaded.version, exposeError(err)
}

// PrepareWrite 以明确 baseRevision 构建新版本；宿主必须在同一结果事务中以
// expectedRevision 校验当前 DB 指针，之后才能引用返回的 Revision。
func (s *Store) PrepareWrite(ctx context.Context, taskID string, baseRevision int, name string, r io.Reader) (Version, error) {
	if err := validatePath(name); err != nil {
		return Version{}, err
	}
	return s.prepare(ctx, taskID, baseRevision, func(base *loadedVersion, remaining int64) ([]archiveEntry, func(), error) {
		f, tmp, err := s.temporary()
		if err != nil {
			return nil, nil, err
		}
		cleanup := func() { f.Close(); s.unlink(tmp) }
		entry, err := spoolFile(ctx, f, name, r, min(s.limits.TaskBytes, remaining))
		if err != nil {
			cleanup()
			return nil, nil, err
		}
		entries := make([]archiveEntry, 0, len(base.entries)+1)
		for _, existing := range base.entries {
			if existing.Path != name {
				entries = append(entries, existing)
			}
		}
		entries = append(entries, entry)
		return entries, cleanup, nil
	})
}

func (s *Store) PrepareDelete(ctx context.Context, taskID string, baseRevision int, name string) (Version, error) {
	if err := validatePath(name); err != nil {
		return Version{}, err
	}
	return s.prepare(ctx, taskID, baseRevision, func(base *loadedVersion, _ int64) ([]archiveEntry, func(), error) {
		entries := make([]archiveEntry, 0, len(base.entries))
		found := false
		for _, entry := range base.entries {
			if entry.Path == name {
				found = true
			} else {
				entries = append(entries, entry)
			}
		}
		if !found {
			return nil, nil, problem(404, "workspace_file_not_found", "工作区文件不存在")
		}
		return entries, nil, nil
	})
}

// PrepareImport 把 TAR 中的普通文件整体替换为新版本。规范目录条目被校验后忽略；
// 符号链接、硬链接、设备、路径穿越、重复名称和文件/目录冲突全部拒绝。
func (s *Store) PrepareImport(ctx context.Context, taskID string, baseRevision int, r io.Reader) (Version, error) {
	return s.prepare(ctx, taskID, baseRevision, func(_ *loadedVersion, remaining int64) ([]archiveEntry, func(), error) {
		f, tmp, err := s.temporary()
		if err != nil {
			return nil, nil, err
		}
		cleanup := func() { f.Close(); s.unlink(tmp) }
		maxArchive := s.limits.TaskBytes + int64(s.limits.TaskFiles)*4096 + (2 << 20)
		maxArchive = min(maxArchive, remaining)
		written, err := io.Copy(&limitWriter{w: f, remaining: remaining}, io.LimitReader(&contextReader{ctx: ctx, r: r}, maxArchive+1))
		if err != nil {
			cleanup()
			return nil, nil, err
		}
		if written > maxArchive {
			cleanup()
			return nil, nil, quotaError("工作区导入归档过大")
		}
		entries, err := readExternalArchive(ctx, f, s.limits)
		if err != nil {
			cleanup()
			return nil, nil, err
		}
		return entries, cleanup, nil
	})
}

func (s *Store) prepare(ctx context.Context, taskID string, baseRevision int, transform func(*loadedVersion, int64) ([]archiveEntry, func(), error)) (Version, error) {
	if err := validateTask(taskID, baseRevision); err != nil {
		return Version{}, err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return Version{}, err
	}
	defer release()
	base, err := s.load(ctx, taskID, baseRevision)
	if err != nil {
		return Version{}, exposeError(err)
	}
	defer base.close()
	used, maxRevision, err := s.usage(taskID)
	if err != nil {
		return Version{}, exposeError(err)
	}
	if maxRevision == int(^uint(0)>>1) {
		return Version{}, problem(409, "workspace_revision_exhausted", "工作区版本数量已达到上限")
	}
	entries, cleanup, err := transform(base, s.limits.GlobalBytes-used)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return Version{}, exposeError(err)
	}
	used, _, err = s.usage(taskID)
	if err != nil {
		return Version{}, exposeError(err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	if err = validateEntries(entries, s.limits); err != nil {
		return Version{}, err
	}
	version := describe(taskID, maxRevision+1, baseRevision, entries)
	if err = s.reserveRevision(taskID, version.Revision, s.limits.GlobalBytes-used); err != nil {
		return Version{}, exposeError(err)
	}
	used, _, err = s.usage(taskID)
	if err != nil {
		return Version{}, exposeError(err)
	}
	file, name, err := s.temporary()
	if err != nil {
		return Version{}, exposeError(err)
	}
	defer func() { file.Close(); s.unlink(name) }()
	writer := &limitWriter{w: file, remaining: s.limits.GlobalBytes - used}
	err = writeArchive(ctx, writer, entries, &version)
	if err != nil {
		return Version{}, exposeError(err)
	}
	if err = file.Sync(); err != nil {
		return Version{}, exposeError(err)
	}
	if err = file.Close(); err != nil {
		return Version{}, exposeError(err)
	}
	if err = ctx.Err(); err != nil {
		return Version{}, contextError(err)
	}
	if s.beforePublish != nil {
		if err = s.beforePublish(); err != nil {
			return Version{}, exposeError(err)
		}
	}
	// 锁内选择未用过的数字版本，并使用 RENAME_NOREPLACE 保证永不覆盖。
	err = unix.Renameat2(int(s.root.Fd()), name, int(s.root.Fd()), archiveName(taskID, version.Revision), unix.RENAME_NOREPLACE)
	if err != nil {
		return Version{}, exposeError(err)
	}
	if err = s.root.Sync(); err != nil {
		return Version{}, exposeError(err)
	}
	return version, nil
}

func (s *Store) reserveRevision(taskID string, revision int, remaining int64) error {
	f, name, err := s.temporary()
	if err != nil {
		return err
	}
	defer func() { f.Close(); s.unlink(name) }()
	if _, err = (&limitWriter{w: f, remaining: remaining}).Write([]byte(strconv.Itoa(revision))); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = unix.Renameat(int(s.root.Fd()), name, int(s.root.Fd()), taskID+".sequence"); err != nil {
		return err
	}
	return s.root.Sync()
}

// Discard 仅供持有宿主 DB 锁并已确认没有任何 DB 引用的版本清理。
// 本包不判断版本是否已发布，也不自动删除历史或失败事务留下的版本。
func (s *Store) Discard(ctx context.Context, taskID string, revision int) error {
	if err := validateTask(taskID, revision); err != nil {
		return err
	}
	if revision == 0 {
		return nil
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	err = s.unlink(archiveName(taskID, revision))
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return exposeError(err)
	}
	return exposeError(s.root.Sync())
}

// RemoveTask 仅供宿主持有数据库锁并确认 Task 已删除且所有版本均无引用后调用。
// Task 标识不得重用；删除中断可以重复调用，本包不会删除其他 Task 或暂存文件。
func (s *Store) RemoveTask(ctx context.Context, taskID string) error {
	if err := validateTask(taskID, 0); err != nil {
		return err
	}
	release, err := s.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	fd, err := unix.Openat(int(s.root.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return exposeError(err)
	}
	dir := os.NewFile(uintptr(fd), ".")
	defer dir.Close()
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return exposeError(err)
	}
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return contextError(err)
		}
		name := entry.Name()
		if strings.HasPrefix(name, taskID+".") && (strings.HasSuffix(name, ".tar") || name == taskID+".sequence") {
			if err = s.unlink(name); err != nil && !errors.Is(err, unix.ENOENT) {
				return exposeError(err)
			}
		}
	}
	return exposeError(s.root.Sync())
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

type limitWriter struct {
	w         io.Writer
	remaining int64
}

func (w *limitWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, quotaError("工作区总存储已达到上限")
	}
	n, err := w.w.Write(p)
	w.remaining -= int64(n)
	return n, err
}
