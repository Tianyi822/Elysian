package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"elysian/server/internal/shared"
)

func uploadTestManager(t *testing.T) (*uploadManager, string) {
	t.Helper()
	m := newUploadManager(t.TempDir(), nil)
	t.Cleanup(m.Close)
	return m, t.TempDir()
}

func uploadTestCheck(t *testing.T, m *uploadManager, dir, name string, size int64) uploadCheckResult {
	t.Helper()
	check, err := m.Check(context.Background(), "session", dir, name, size)
	if err != nil {
		t.Fatal(err)
	}
	return check
}

func uploadTestStatus(t *testing.T, err error, status int) {
	t.Helper()
	var bad *shared.InvalidRequestError
	if !errors.As(err, &bad) || bad.Status != status {
		t.Fatalf("want status %d, got %v", status, err)
	}
}

func uploadTestClean(t *testing.T, dir string) {
	t.Helper()
	items, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if strings.HasPrefix(item.Name(), stagingDirPrefix) {
			t.Fatalf("left staging: %s", item.Name())
		}
	}
}

func TestUploadCreateReplacePreservesBytesModeAndOwner(t *testing.T) {
	m, dir := uploadTestManager(t)
	name := "中文 压缩包.tar.gz"
	payload := []byte{0x1f, 0x8b, 0, 0xff, 1, 2}
	check := uploadTestCheck(t, m, dir, name, int64(len(payload)))
	if check.State != "create" || check.Existing != nil {
		t.Fatalf("check: %#v", check)
	}
	entry, err := m.Upload(context.Background(), "session", dir, name, check.Token, false, bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		t.Fatal(err)
	}
	if entry.Name != name || entry.Mode != "644" || entry.SizeBytes == nil || *entry.SizeBytes != int64(len(payload)) {
		t.Fatalf("entry: %#v", entry)
	}
	actual, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatalf("bytes=%v err=%v", actual, err)
	}
	if err := os.Chmod(filepath.Join(dir, name), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	check = uploadTestCheck(t, m, dir, name, 3)
	if check.State != "replace" || check.Existing == nil || check.Existing.Mode != "600" {
		t.Fatalf("check: %#v", check)
	}
	entry, err = m.Upload(context.Background(), "session", dir, name, check.Token, true, strings.NewReader("new"), 3)
	if err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if entry.Mode != "600" || statsFromInfo(before).uid != statsFromInfo(after).uid || statsFromInfo(before).gid != statsFromInfo(after).gid {
		t.Fatalf("ownership/permissions changed: %#v", entry)
	}
	actual, err = os.ReadFile(filepath.Join(dir, name))
	if err != nil || string(actual) != "new" {
		t.Fatalf("bytes=%q err=%v", actual, err)
	}
	uploadTestClean(t, dir)
}

func TestUploadRejectsForbiddenInvalidAndNonRegularTargets(t *testing.T) {
	m, dir := uploadTestManager(t)
	if err := os.Mkdir(filepath.Join(dir, "directory"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("missing", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(dir, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../escape", ".", "..", "a/b", "bad\nname", "directory", "link", "fifo"} {
		t.Run(name, func(t *testing.T) {
			_, err := m.Check(context.Background(), "session", dir, name, 1)
			uploadTestStatus(t, err, 400)
		})
	}
	for _, forbidden := range []string{"/proc", "/sys", "/dev", "/app", "/var/lib/elysian", filepath.Join(m.home, ".Elysian"), filepath.Join(m.home, ".ssh")} {
		_, err := m.Check(context.Background(), "session", forbidden, "file", 1)
		uploadTestStatus(t, err, 400)
	}
	if err := os.Mkdir(filepath.Join(m.home, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(m.home, ".ssh"), filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}
	_, err := m.Check(context.Background(), "session", filepath.Join(dir, "alias"), "file", 1)
	uploadTestStatus(t, err, 400)
	_, err = m.Check(context.Background(), "session", m.home, ".ssh", 1)
	uploadTestStatus(t, err, 400)
	_, err = m.Check(context.Background(), "", dir, "file", 1)
	uploadTestStatus(t, err, 401)
	m.maxBytes = 1
	_, err = m.Check(context.Background(), "session", dir, "file", 2)
	uploadTestStatus(t, err, 413)
}

func TestUploadCheckBindsSessionTargetAndDecisionAndExpires(t *testing.T) {
	m, dir := uploadTestManager(t)
	check := uploadTestCheck(t, m, dir, "file", 1)
	_, err := m.Upload(context.Background(), "other-session", dir, "file", check.Token, false, strings.NewReader("x"), 1)
	uploadTestStatus(t, err, 409)
	_, err = m.Upload(context.Background(), "session", dir, "other", check.Token, false, strings.NewReader("x"), 1)
	uploadTestStatus(t, err, 409)
	_, err = m.Upload(context.Background(), "session", dir, "file", check.Token, true, strings.NewReader("x"), 1)
	uploadTestStatus(t, err, 409)
	_, err = m.Upload(context.Background(), "session", dir, "file", check.Token, false, strings.NewReader("x"), 1)
	uploadTestStatus(t, err, 409)
	check = uploadTestCheck(t, m, dir, "file", 1)
	future := time.Now().Add(uploadTokenTTL + time.Second)
	m.now = func() time.Time { return future }
	_, err = m.Upload(context.Background(), "session", dir, "file", check.Token, false, strings.NewReader("x"), 1)
	uploadTestStatus(t, err, 409)
	if _, err := os.Stat(filepath.Join(dir, "file")); !os.IsNotExist(err) {
		t.Fatalf("unexpected target: %v", err)
	}
}

type uploadHookReader struct {
	once   sync.Once
	hook   func()
	reader io.Reader
}

func (r *uploadHookReader) Read(p []byte) (int, error) {
	r.once.Do(r.hook)
	return r.reader.Read(p)
}

func TestUploadRechecksChangesAfterStreamingAndKeepsOldFile(t *testing.T) {
	for _, action := range []string{"rewrite", "link", "new-target", "swap-parent"} {
		t.Run(action, func(t *testing.T) {
			m, dir := uploadTestManager(t)
			target := filepath.Join(dir, "file")
			overwrite := action != "new-target"
			if overwrite {
				if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			check := uploadTestCheck(t, m, dir, "file", 3)
			cleanupDir := dir
			reader := &uploadHookReader{reader: strings.NewReader("new"), hook: func() {
				var err error
				switch action {
				case "rewrite", "new-target":
					err = os.WriteFile(target, []byte("changed"), 0600)
				case "link":
					err = os.Remove(target)
					if err == nil {
						err = os.Symlink("missing", target)
					}
				case "swap-parent":
					cleanupDir = dir + "-moved"
					err = os.Rename(dir, cleanupDir)
					if err == nil {
						err = os.Mkdir(dir, 0700)
					}
					t.Cleanup(func() { _ = os.RemoveAll(cleanupDir) })
				}
				if err != nil {
					t.Fatal(err)
				}
			}}
			_, err := m.Upload(context.Background(), "session", dir, "file", check.Token, overwrite, reader, 3)
			uploadTestStatus(t, err, 409)
			uploadTestClean(t, cleanupDir)
			if action == "rewrite" || action == "new-target" {
				b, err := os.ReadFile(target)
				if err != nil || string(b) != "changed" {
					t.Fatalf("changed target overwritten: %q %v", b, err)
				}
			}
		})
	}
}

func TestUploadFailureAndCancellationCleanStaging(t *testing.T) {
	for _, action := range []string{"short", "long", "header", "cancel", "close", "read-error"} {
		t.Run(action, func(t *testing.T) {
			m, dir := uploadTestManager(t)
			if err := os.WriteFile(filepath.Join(dir, "file"), []byte("old"), 0600); err != nil {
				t.Fatal(err)
			}
			check := uploadTestCheck(t, m, dir, "file", 3)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var reader io.Reader = strings.NewReader("new")
			length := int64(3)
			switch action {
			case "short":
				reader = strings.NewReader("x")
			case "long":
				reader = strings.NewReader("too long")
			case "header":
				length = 5
			case "cancel":
				reader = &uploadHookReader{reader: reader, hook: cancel}
			case "close":
				reader = &uploadHookReader{reader: reader, hook: m.Close}
			case "read-error":
				reader = uploadFailReader{}
			}
			_, err := m.Upload(ctx, "session", dir, "file", check.Token, true, reader, length)
			if err == nil {
				t.Fatal("expected failure")
			}
			b, readErr := os.ReadFile(filepath.Join(dir, "file"))
			if readErr != nil || string(b) != "old" {
				t.Fatalf("old file changed: %q %v", b, readErr)
			}
			uploadTestClean(t, dir)
		})
	}
}

type uploadFailReader struct{}

func (uploadFailReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestUploadConcurrentCreationCannotOverwrite(t *testing.T) {
	m, dir := uploadTestManager(t)
	a := uploadTestCheck(t, m, dir, "file", 1)
	b := uploadTestCheck(t, m, dir, "file", 1)
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, check := range []uploadCheckResult{a, b} {
		go func(i int, check uploadCheckResult) {
			<-start
			_, err := m.Upload(context.Background(), "session", dir, "file", check.Token, false, bytes.NewReader([]byte{byte('a' + i)}), 1)
			results <- err
		}(i, check)
	}
	close(start)
	success := 0
	for i := 0; i < 2; i++ {
		if err := <-results; err == nil {
			success++
		} else {
			uploadTestStatus(t, err, 409)
		}
	}
	if success != 1 {
		t.Fatalf("want 1 successful upload, got %d", success)
	}
	uploadTestClean(t, dir)
}

func TestUploadEmptyAndAliasedDirectory(t *testing.T) {
	m, dir := uploadTestManager(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(dir, alias); err != nil {
		t.Fatal(err)
	}
	check := uploadTestCheck(t, m, alias, "empty", 0)
	entry, err := m.Upload(context.Background(), "session", alias, "empty", check.Token, false, strings.NewReader(""), 0)
	if err != nil {
		t.Fatal(err)
	}
	if entry.SizeBytes == nil || *entry.SizeBytes != 0 {
		t.Fatalf("entry: %#v", entry)
	}
	uploadTestClean(t, dir)
}

// 数 GB 验收只在显式启用时运行，避免每轮门禁重复占用磁盘写入量。
func TestUploadLargeStreaming(t *testing.T) {
	if os.Getenv("ELYSIAN_FILES_LARGE_UPLOAD_TEST") != "1" {
		t.Skip("设置 ELYSIAN_FILES_LARGE_UPLOAD_TEST=1 执行 3 GiB 上传流式验收")
	}
	m, dir := uploadTestManager(t)
	const size = int64(3 << 30)
	var space unix.Statfs_t
	if err := unix.Statfs(dir, &space); err != nil {
		t.Fatal(err)
	}
	if uint64(space.Bavail)*uint64(space.Bsize) < uint64(size+(512<<20)) {
		t.Fatal("专用临时目录可用空间不足 3.5 GiB，无法完成大文件验收")
	}
	check := uploadTestCheck(t, m, dir, "large.bin", size)
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	reader := &uploadLargeReader{remaining: size, peakAlloc: before.Alloc}
	started := time.Now()
	entry, err := m.Upload(context.Background(), "session", dir, "large.bin", check.Token, false, reader, size)
	if err != nil {
		t.Fatal(err)
	}
	reader.sample()
	if reader.remaining != 0 || entry.SizeBytes == nil || *entry.SizeBytes != size {
		t.Fatalf("上传长度不完整：剩余=%d，条目=%#v", reader.remaining, entry)
	}
	info, err := os.Stat(filepath.Join(dir, "large.bin"))
	if err != nil || info.Size() != size {
		t.Fatalf("落盘大小不符：%v，%v", info, err)
	}
	if reader.maxRead > 64<<10 {
		t.Fatalf("读取缓冲超出 64 KiB：%d", reader.maxRead)
	}
	growth := reader.peakAlloc - before.Alloc
	if growth > 32<<20 {
		t.Fatalf("大文件传输堆内存增长过高：%d 字节", growth)
	}
	t.Logf("3 GiB 完整落盘；耗时=%s，最大读取缓冲=%d 字节，采样堆内存峰值增长=%d 字节", time.Since(started).Round(time.Millisecond), reader.maxRead, growth)
	uploadTestClean(t, dir)
}

type uploadLargeReader struct {
	remaining  int64
	readBytes  int64
	nextSample int64
	maxRead    int
	peakAlloc  uint64
}

func (r *uploadLargeReader) sample() {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	if stats.Alloc > r.peakAlloc {
		r.peakAlloc = stats.Alloc
	}
}

func (r *uploadLargeReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if len(p) > r.maxRead {
		r.maxRead = len(p)
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	clear(p)
	r.remaining -= int64(len(p))
	r.readBytes += int64(len(p))
	if r.readBytes >= r.nextSample {
		r.sample()
		r.nextSample = r.readBytes + (16 << 20)
	}
	return len(p), nil
}
