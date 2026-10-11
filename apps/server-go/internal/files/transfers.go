package files

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

const (
	maxDownloadArchiveBytes int64 = 10 << 30
	maxDownloadTotalBytes   int64 = 20 << 30
	downloadTTL                   = 10 * time.Minute
	downloadPrepareTimeout        = 30 * time.Minute
	fileTransferTimeout           = 2 * time.Hour
)

type downloadResult struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	ExpiresAt string `json:"expiresAt"`
}

type preparedDownload struct {
	result  downloadResult
	session string
	file    *os.File
	info    os.FileInfo
	archive bool
	expires time.Time
}

// TransferManager 持有短期下载句柄与上传确认；不持久化任务或文件内容。
// 上传和实际下载共享两条传输槽，目录打包另有一条槽。
type TransferManager struct {
	mu           sync.Mutex
	root         string
	ready        map[string]*preparedDownload
	preparing    int
	archiveBytes int64
	closed       bool
	ctx          context.Context
	cancel       context.CancelFunc
	done         chan struct{}
	wg           sync.WaitGroup
	transfers    chan struct{}
	packing      chan struct{}
	uploads      *uploadManager
	archiveLimit int64
	totalLimit   int64
	ttl          time.Duration
	now          func() time.Time
	archiveDir   *os.File
	initErr      error
}

func NewTransferManager(root string, accounts seam.SystemAccounts) *TransferManager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &TransferManager{root: root, ready: make(map[string]*preparedDownload), ctx: ctx, cancel: cancel,
		done: make(chan struct{}), transfers: make(chan struct{}, 2), packing: make(chan struct{}, 1),
		uploads: newUploadManager(realHostDeps{}.HomeDir(), accounts), archiveLimit: maxDownloadArchiveBytes,
		totalLimit: maxDownloadTotalBytes, ttl: downloadTTL, now: time.Now}
	m.initErr = m.initializeArchiveDirectory()
	go func() {
		defer close(m.done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.expire()
			}
		}
	}()
	return m
}

func transferError(status int, message string) error {
	return &shared.InvalidRequestError{Status: status, Message: message}
}

func (m *TransferManager) expire() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, d := range m.ready {
		if !m.now().Before(d.expires) {
			delete(m.ready, id)
			m.releaseLocked(d)
		}
	}
}

func (m *TransferManager) releaseLocked(d *preparedDownload) {
	_ = d.file.Close()
	if d.archive {
		m.archiveBytes -= d.result.SizeBytes
	}
}

func (m *TransferManager) begin(parent context.Context, timeout time.Duration) (context.Context, func(), error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, nil, transferError(503, "文件传输正在关闭")
	}
	m.wg.Add(1)
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, timeout)
	stop := context.AfterFunc(m.ctx, cancel)
	return ctx, func() { stop(); cancel(); m.wg.Done() }, nil
}

func (m *TransferManager) acquireTransfer() (func(), error) {
	select {
	case m.transfers <- struct{}{}:
		return func() { <-m.transfers }, nil
	default:
		return nil, transferError(429, "已有两个文件正在传输，请稍后重试")
	}
}

func (m *TransferManager) Prepare(parent context.Context, session, path string) (downloadResult, error) {
	ctx, finish, err := m.begin(parent, downloadPrepareTimeout)
	if err != nil {
		return downloadResult{}, err
	}
	defer finish()
	m.expire()
	m.mu.Lock()
	if len(m.ready)+m.preparing >= 8 {
		m.mu.Unlock()
		return downloadResult{}, transferError(429, "待下载文件已达上限，请完成已有下载后重试")
	}
	m.preparing++
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.preparing--; m.mu.Unlock() }()
	d, err := m.prepareDownload(ctx, path)
	if err != nil {
		return downloadResult{}, err
	}
	d.session = session
	d.expires = m.now().Add(m.ttl)
	var raw [24]byte
	if _, err = rand.Read(raw[:]); err != nil {
		m.release(d)
		return downloadResult{}, err
	}
	d.result.ID = hex.EncodeToString(raw[:])
	d.result.ExpiresAt = d.expires.UTC().Format(time.RFC3339)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || ctx.Err() != nil {
		m.releaseLocked(d)
		return downloadResult{}, errors.New("下载准备已取消")
	}
	m.ready[d.result.ID] = d
	return d.result, nil
}

func (m *TransferManager) claim(id, session string) (*preparedDownload, error) {
	m.expire()
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.ready[id]
	if d == nil || d.session != session {
		return nil, transferError(404, "下载链接无效或已过期，请重新下载")
	}
	delete(m.ready, id)
	return d, nil
}

func (m *TransferManager) release(d *preparedDownload) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.releaseLocked(d)
}

// 私有临时文件打开后立即解除目录项：打包祖先目录不会把正在生成的归档包进自身，
// 进程异常退出也由内核回收。初始化只清理由本域命名前缀确定的旧残留。
func (m *TransferManager) initializeArchiveDirectory() error {
	if err := os.MkdirAll(filepath.Dir(m.root), 0700); err != nil {
		return err
	}
	parentPath, err := filepath.EvalSymlinks(filepath.Dir(m.root))
	if err != nil {
		return err
	}
	parent, err := uploadOpenDirectory(parentPath)
	if err != nil {
		return err
	}
	defer parent.Close()
	name := filepath.Base(m.root)
	if err := unix.Mkdirat(int(parent.Fd()), name, 0700); err != nil && !errors.Is(err, unix.EEXIST) {
		return err
	}
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(fd), m.root)
	valid := false
	defer func() {
		if !valid {
			_ = dir.Close()
		}
	}()
	if err = dir.Chmod(0700); err != nil {
		return err
	}
	entries, err := dir.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "download-") {
			if err := unix.Unlinkat(fd, entry.Name(), 0); err != nil {
				return err
			}
		}
	}
	m.archiveDir = dir
	valid = true
	return nil
}

func (m *TransferManager) archiveFile() (*os.File, error) {
	if m.initErr != nil {
		return nil, fmt.Errorf("无法准备下载临时目录：%w", m.initErr)
	}
	id, err := uploadRandomID()
	if err != nil {
		return nil, err
	}
	name := "download-" + id + ".tar.gz"
	fd, err := unix.Openat(int(m.archiveDir.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	if err = unix.Unlinkat(int(m.archiveDir.Fd()), name, 0); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

func (m *TransferManager) Close(ctx context.Context) error {
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.cancel()
		for id, d := range m.ready {
			delete(m.ready, id)
			m.releaseLocked(d)
		}
		m.uploads.Close()
	}
	m.mu.Unlock()
	stopped := make(chan struct{})
	go func() {
		m.wg.Wait()
		<-m.done
		if m.archiveDir != nil {
			_ = m.archiveDir.Close()
		}
		close(stopped)
	}()
	select {
	case <-stopped:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
