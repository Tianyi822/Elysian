package files

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const (
	uploadMaxBytes  = int64(10 << 30)
	uploadTokenTTL  = 10 * time.Minute
	uploadMaxTokens = 128
)

type uploadCheckResult struct {
	State     string     `json:"state"`
	Token     string     `json:"token"`
	Existing  *fileEntry `json:"existing,omitempty"`
	ExpiresAt string     `json:"expiresAt"`
}

// 比较对象身份、内容与权限版本；不比较仅因其他读者访问就会改变的 atime。
type uploadFingerprint struct {
	dev   uint64
	ino   uint64
	size  int64
	mode  uint32
	uid   uint32
	gid   uint32
	mtime unix.Timespec
	ctime unix.Timespec
}

func uploadVersion(st *unix.Stat_t) uploadFingerprint {
	return uploadFingerprint{uint64(st.Dev), st.Ino, st.Size, uint32(st.Mode), st.Uid, st.Gid, st.Mtim, st.Ctim}
}

type uploadCheckToken struct {
	session, dirPath, name, realDir string
	size                            int64
	parentDev, parentIno            uint64
	existing                        *uploadFingerprint
	expires                         time.Time
}

type uploadTargetLock struct {
	gate chan struct{}
	refs int
}

type uploadManager struct {
	mutationMu *sync.Mutex
	home       string
	accounts   seam.SystemAccounts
	maxBytes   int64
	now        func() time.Time
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	closed     bool
	tokens     map[string]uploadCheckToken
	locks      map[string]*uploadTargetLock
}

func newUploadManager(home string, accounts seam.SystemAccounts) *uploadManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &uploadManager{home: home, accounts: accounts, maxBytes: uploadMaxBytes, now: time.Now,
		ctx: ctx, cancel: cancel, tokens: make(map[string]uploadCheckToken), locks: make(map[string]*uploadTargetLock)}
}

func (m *uploadManager) Close() {
	m.mu.Lock()
	m.closed = true
	clear(m.tokens)
	m.cancel()
	m.mu.Unlock()
}

func uploadConflict() error {
	return &shared.InvalidRequestError{Status: http.StatusConflict, Message: "上传目标或校验已变化，请重新检查并确认"}
}

func uploadRandomID() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (m *uploadManager) validateTarget(dirPath, name string) (string, error) {
	dir, err := normalizeServerFilePath(dirPath)
	if err != nil {
		return "", err
	}
	if !isValidFileName(name) || hasControlChars(name) {
		return "", shared.InvalidRequest("无效的名称：" + name)
	}
	target, err := normalizeServerFilePath(childPathOf(dir, name))
	if err != nil {
		return "", err
	}
	if isForbiddenWritePath(dir, m.home) || isForbiddenWritePath(target, m.home) {
		return "", shared.InvalidRequest("拒绝操作受保护路径：" + target)
	}
	return dir, nil
}

// 先解析目录别名，再逐段以不跟随链接的方式打开；暂存、状态检查和发布均相对此句柄。
func uploadOpenDirectory(realDir string) (*os.File, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range nonEmptySegments(realDir) {
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), realDir), nil
}

func (m *uploadManager) openParent(dirPath, name string) (*os.File, string, error) {
	realDir, err := filepath.EvalSymlinks(dirPath)
	if err != nil {
		return nil, "", fsErrorInChinese("读取上传目录失败", err)
	}
	if isForbiddenWritePath(realDir, m.home) || isForbiddenWritePath(childPathOf(realDir, name), m.home) {
		return nil, "", shared.InvalidRequest("拒绝操作受保护路径：" + childPathOf(realDir, name))
	}
	dir, err := uploadOpenDirectory(realDir)
	if err != nil {
		return nil, "", fsErrorInChinese("打开上传目录失败", err)
	}
	return dir, realDir, nil
}

func uploadTargetVersion(dir *os.File, name string) (*uploadFingerprint, error) {
	var st unix.Stat_t
	err := unix.Fstatat(int(dir.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if errors.Is(err, unix.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, fsErrorInChinese("读取上传目标失败", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		return nil, shared.InvalidRequest("同名条目为目录、符号链接或特殊文件，不能覆盖：" + name)
	}
	v := uploadVersion(&st)
	return &v, nil
}

func (m *uploadManager) entry(ctx context.Context, name string, v uploadFingerprint) fileEntry {
	names := make(map[int]string)
	if m.accounts != nil {
		if records, err := m.accounts.PasswdAll(ctx); err == nil {
			for _, record := range records {
				if _, exists := names[record.UID]; !exists {
					names[record.UID] = record.Name
				}
			}
		}
	}
	return entryOf(name, entryStats{mode: os.FileMode(v.mode & 0777), size: v.size,
		modTime: time.Unix(v.mtime.Sec, v.mtime.Nsec), uid: int(v.uid), gid: int(v.gid)}, names)
}

func (m *uploadManager) Check(ctx context.Context, session, dirPath, name string, size int64) (uploadCheckResult, error) {
	if err := ctx.Err(); err != nil {
		return uploadCheckResult{}, err
	}
	if session == "" {
		return uploadCheckResult{}, &shared.InvalidRequestError{Status: 401, Message: "请先登录"}
	}
	if size < 0 {
		return uploadCheckResult{}, shared.InvalidRequest("上传文件大小无效")
	}
	if size > m.maxBytes {
		return uploadCheckResult{}, &shared.InvalidRequestError{Status: 413, Message: "单文件上传大小不能超过 10 GiB"}
	}
	dirPath, err := m.validateTarget(dirPath, name)
	if err != nil {
		return uploadCheckResult{}, err
	}
	dir, realDir, err := m.openParent(dirPath, name)
	if err != nil {
		return uploadCheckResult{}, err
	}
	defer dir.Close()
	var parent unix.Stat_t
	if err := unix.Fstat(int(dir.Fd()), &parent); err != nil {
		return uploadCheckResult{}, err
	}
	existing, err := uploadTargetVersion(dir, name)
	if err != nil {
		return uploadCheckResult{}, err
	}
	id, err := uploadRandomID()
	if err != nil {
		return uploadCheckResult{}, err
	}
	now := m.now()
	token := uploadCheckToken{session: session, dirPath: dirPath, name: name, realDir: realDir, size: size,
		parentDev: uint64(parent.Dev), parentIno: parent.Ino, existing: existing, expires: now.Add(uploadTokenTTL)}
	result := uploadCheckResult{State: "create", Token: id, ExpiresAt: token.expires.UTC().Format(time.RFC3339)}
	if existing != nil {
		result.State = "replace"
		entry := m.entry(ctx, name, *existing)
		result.Existing = &entry
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return uploadCheckResult{}, &shared.InvalidRequestError{Status: 503, Message: "文件传输已关闭"}
	}
	for key, old := range m.tokens {
		if !old.expires.After(now) {
			delete(m.tokens, key)
		}
	}
	if len(m.tokens) >= uploadMaxTokens {
		return uploadCheckResult{}, &shared.InvalidRequestError{Status: 429, Message: "待处理的上传校验过多，请稍后重试"}
	}
	m.tokens[id] = token
	return result, nil
}

func (m *uploadManager) consumeToken(session, dirPath, name, id string) (uploadCheckToken, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	token, ok := m.tokens[id]
	if m.closed || !ok || token.session != session || token.dirPath != dirPath || token.name != name {
		return uploadCheckToken{}, uploadConflict()
	}
	delete(m.tokens, id)
	if !token.expires.After(m.now()) {
		return uploadCheckToken{}, uploadConflict()
	}
	return token, nil
}

func (m *uploadManager) lockTarget(ctx context.Context, key string) (func(), error) {
	m.mu.Lock()
	lock := m.locks[key]
	if lock == nil {
		lock = &uploadTargetLock{gate: make(chan struct{}, 1)}
		m.locks[key] = lock
	}
	lock.refs++
	m.mu.Unlock()
	dropRef := func() {
		m.mu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(m.locks, key)
		}
		m.mu.Unlock()
	}
	select {
	case lock.gate <- struct{}{}:
		return func() { <-lock.gate; dropRef() }, nil
	case <-ctx.Done():
		dropRef()
		return nil, ctx.Err()
	}
}

func (m *uploadManager) verifyTarget(dir *os.File, token uploadCheckToken) error {
	current, realDir, err := m.openParent(token.dirPath, token.name)
	if err != nil {
		return uploadConflict()
	}
	defer current.Close()
	var now, opened unix.Stat_t
	if unix.Fstat(int(current.Fd()), &now) != nil || unix.Fstat(int(dir.Fd()), &opened) != nil ||
		realDir != token.realDir || uint64(now.Dev) != token.parentDev || now.Ino != token.parentIno ||
		now.Dev != opened.Dev || now.Ino != opened.Ino {
		return uploadConflict()
	}
	target, err := uploadTargetVersion(dir, token.name)
	if err != nil {
		return uploadConflict()
	}
	if (target == nil) != (token.existing == nil) {
		return uploadConflict()
	}
	if target != nil && *target != *token.existing {
		return uploadConflict()
	}
	return nil
}

type uploadContextReader struct {
	ctx context.Context
	src io.Reader
}

func (r uploadContextReader) Read(b []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.src.Read(b)
}

// Upload 流式接收正文，在进程内目标锁下完成传输后再次核对覆盖确认，再 renameat 发布。
// 外部特权进程仍可能在最终核对与 renameat 之间改变目标，与现有文件管理边界一致。
func (m *uploadManager) Upload(ctx context.Context, session, dirPath, name, id string, overwrite bool, src io.Reader, declaredLength int64) (fileEntry, error) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(m.ctx, cancel)
	defer func() { stop(); cancel() }()
	if err := ctx.Err(); err != nil {
		return fileEntry{}, err
	}
	dirPath, err := m.validateTarget(dirPath, name)
	if err != nil {
		return fileEntry{}, err
	}
	token, err := m.consumeToken(session, dirPath, name, id)
	if err != nil {
		return fileEntry{}, err
	}
	if (token.existing != nil) != overwrite {
		return fileEntry{}, uploadConflict()
	}
	if declaredLength >= 0 && declaredLength != token.size {
		return fileEntry{}, shared.InvalidRequest("上传正文长度与已检查文件大小不一致")
	}
	unlock, err := m.lockTarget(ctx, childPathOf(token.realDir, name))
	if err != nil {
		return fileEntry{}, err
	}
	defer unlock()
	dir, realDir, err := m.openParent(dirPath, name)
	if err != nil {
		return fileEntry{}, err
	}
	defer dir.Close()
	if realDir != token.realDir {
		return fileEntry{}, uploadConflict()
	}
	if err := m.verifyTarget(dir, token); err != nil {
		return fileEntry{}, err
	}
	stageID, err := uploadRandomID()
	if err != nil {
		return fileEntry{}, err
	}
	stageName := stagingDirPrefix + "upload-" + stageID
	if err := unix.Mkdirat(int(dir.Fd()), stageName, 0700); err != nil {
		return fileEntry{}, fsErrorInChinese("创建上传暂存目录失败", err)
	}
	defer unix.Unlinkat(int(dir.Fd()), stageName, unix.AT_REMOVEDIR)
	stageFD, err := unix.Openat(int(dir.Fd()), stageName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fileEntry{}, fsErrorInChinese("打开上传暂存目录失败", err)
	}
	defer unix.Close(stageFD)
	fd, err := unix.Openat(stageFD, stagedArtifactName, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return fileEntry{}, fsErrorInChinese("创建上传暂存文件失败", err)
	}
	file := os.NewFile(uintptr(fd), stagedArtifactName)
	defer file.Close()
	defer unix.Unlinkat(stageFD, stagedArtifactName, 0)
	n, err := io.CopyBuffer(file, io.LimitReader(uploadContextReader{ctx: ctx, src: src}, token.size+1), make([]byte, 64*1024))
	if err != nil {
		return fileEntry{}, fsErrorInChinese("上传未完成", err)
	}
	if err := ctx.Err(); err != nil {
		return fileEntry{}, err
	}
	if n != token.size {
		return fileEntry{}, shared.InvalidRequest("上传正文长度与已检查文件大小不一致")
	}
	mode := uint32(0644)
	if token.existing != nil {
		mode = token.existing.mode & 07777
		var staged unix.Stat_t
		if err := unix.Fstat(fd, &staged); err != nil {
			return fileEntry{}, err
		}
		if staged.Uid != token.existing.uid || staged.Gid != token.existing.gid {
			if err := unix.Fchown(fd, int(token.existing.uid), int(token.existing.gid)); err != nil {
				return fileEntry{}, fsErrorInChinese("保留原文件属主失败", err)
			}
		}
	}
	if err := unix.Fchmod(fd, mode); err != nil {
		return fileEntry{}, fsErrorInChinese("设置上传文件权限失败", err)
	}
	if err := file.Sync(); err != nil {
		return fileEntry{}, fsErrorInChinese("同步上传文件失败", err)
	}
	if m.mutationMu != nil {
		m.mutationMu.Lock()
		defer m.mutationMu.Unlock()
	}
	if err := m.verifyTarget(dir, token); err != nil {
		return fileEntry{}, err
	}
	if err := ctx.Err(); err != nil {
		return fileEntry{}, err
	}
	// 关闭与最终发布共用短临界区，Close 返回后不能再落下一次新发布。
	m.mu.Lock()
	if m.closed {
		err = context.Canceled
	} else if err = ctx.Err(); err == nil {
		if token.existing == nil {
			// linkat 原子拒绝已占用的名字（含符号链接）；同一文件系统内发布后移除私有暂存链接。
			err = unix.Linkat(stageFD, stagedArtifactName, int(dir.Fd()), name, 0)
		} else {
			err = unix.Renameat(stageFD, stagedArtifactName, int(dir.Fd()), name)
		}
	}
	m.mu.Unlock()
	if errors.Is(err, unix.EEXIST) {
		return fileEntry{}, uploadConflict()
	}
	if err != nil {
		return fileEntry{}, fsErrorInChinese("发布上传文件失败", err)
	}
	if err := dir.Sync(); err != nil {
		return fileEntry{}, fmt.Errorf("上传已发布，但同步目录失败，请回读文件状态：%w", err)
	}
	var published unix.Stat_t
	if err := unix.Fstat(fd, &published); err != nil {
		return fileEntry{}, fsErrorInChinese("回读上传结果失败", err)
	}
	return m.entry(ctx, name, uploadVersion(&published)), nil
}
