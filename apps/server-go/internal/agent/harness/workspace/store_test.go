package workspace

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T, options ...Options) (*Store, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "workspace")
	s, err := Open(root, options...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, root
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var actual *Error
	if !errors.As(err, &actual) || actual.Code != code {
		t.Fatalf("期望错误 %s，实际 %v", code, err)
	}
}

func TestWorkspaceImmutableVersionsAndRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, root := testStore(t)
	empty, err := s.List(ctx, "task-a_123", 0)
	if err != nil || empty.Revision != 0 || empty.FileCount != 0 || empty.Digest == "" {
		t.Fatalf("空版本：%+v %v", empty, err)
	}
	first, err := s.PrepareWrite(ctx, "task-a_123", 0, "src/main.txt", strings.NewReader("第一版"))
	if err != nil || first.Revision != 1 || first.BaseRevision != 0 || first.FileCount != 1 {
		t.Fatalf("写入：%+v %v", first, err)
	}
	second, err := s.PrepareWrite(ctx, "task-a_123", first.Revision, "src/main.txt", strings.NewReader("第二版"))
	if err != nil || second.BaseRevision != first.Revision || second.Digest == first.Digest {
		t.Fatalf("更新：%+v %v", second, err)
	}
	old, version, err := s.Read(ctx, "task-a_123", first.Revision, "src/main.txt")
	if err != nil || string(old) != "第一版" || version != first {
		t.Fatalf("旧版本改变：%q %+v %v", old, version, err)
	}
	third, err := s.PrepareWrite(ctx, "task-a_123", second.Revision, "empty", strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	var export bytes.Buffer
	exported, err := s.Export(ctx, "task-a_123", third.Revision, &export)
	if err != nil || exported != third {
		t.Fatalf("导出：%+v %v", exported, err)
	}
	tr := tar.NewReader(bytes.NewReader(export.Bytes()))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if h.Name == manifestName || h.Mode != 0o600 || h.Typeflag != tar.TypeReg {
			t.Fatalf("导出元数据：%+v", h)
		}
	}
	imported, err := s.PrepareImport(ctx, "different-task", 0, bytes.NewReader(export.Bytes()))
	if err != nil || imported.Digest != third.Digest || imported.Bytes != third.Bytes {
		t.Fatalf("导入：%+v %v", imported, err)
	}
	deleted, err := s.PrepareDelete(ctx, "task-a_123", third.Revision, "src/main.txt")
	if err != nil || deleted.FileCount != 1 || deleted.Bytes != 0 {
		t.Fatalf("删除：%+v %v", deleted, err)
	}
	_, _, err = s.Read(ctx, "task-a_123", deleted.Revision, "src/main.txt")
	requireCode(t, err, "workspace_file_not_found")
	for _, name := range []string{".lock", archiveName("task-a_123", first.Revision), archiveName("different-task", imported.Revision)} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("权限 %s：%v %v", name, info, err)
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	reopened, err := s.Version(ctx, "task-a_123", second.Revision)
	if err != nil || reopened != second {
		t.Fatalf("重新打开：%+v %v", reopened, err)
	}
}

func TestWorkspaceConcurrentPrepareKeepsBothCandidates(t *testing.T) {
	s, root := testStore(t)
	other, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	ctx := context.Background()
	base, err := s.PrepareWrite(ctx, "task", 0, "file", strings.NewReader("base"))
	if err != nil {
		t.Fatal(err)
	}
	const count = 12
	var wg sync.WaitGroup
	revisions := make(chan int, count)
	for index := 0; index < count; index++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			store := s
			if i%2 == 0 {
				store = other
			}
			v, err := store.PrepareWrite(ctx, "task", base.Revision, "file", strings.NewReader("candidate"))
			if err != nil {
				t.Errorf("并发版本：%v", err)
				return
			}
			if v.BaseRevision != base.Revision {
				t.Errorf("基础版本变化：%+v", v)
			}
			revisions <- v.Revision
		}(index)
	}
	wg.Wait()
	close(revisions)
	actual := make([]int, 0, count)
	for revision := range revisions {
		actual = append(actual, revision)
	}
	sort.Ints(actual)
	if len(actual) != count {
		t.Fatalf("版本数：%v", actual)
	}
	for i, revision := range actual {
		if revision != i+2 {
			t.Fatalf("版本未唯一递增：%v", actual)
		}
	}
	data, _, err := s.Read(ctx, "task", base.Revision, "file")
	if err != nil || string(data) != "base" {
		t.Fatalf("基础版本改变：%q %v", data, err)
	}
}

func TestWorkspaceInvalidPathsAndLinks(t *testing.T) {
	s, root := testStore(t)
	ctx := context.Background()
	for _, name := range []string{"", "/absolute", "../outside", "a/../b", "a/./b", "a//b", "a/", "C:/file", "a\\b", "line\nname", manifestName} {
		if _, err := s.PrepareWrite(ctx, "task", 0, name, strings.NewReader("x")); err == nil {
			t.Errorf("接受非法路径 %q", name)
		}
	}
	for _, task := range []string{"../task", "/task", "a.b", "", "a/b"} {
		if _, err := s.Version(ctx, task, 0); err == nil {
			t.Errorf("接受非法任务 %q", task)
		}
	}
	_, err := s.PrepareWrite(ctx, "task", 42, "valid", strings.NewReader("x"))
	requireCode(t, err, "workspace_revision_not_found")
	v, err := s.PrepareWrite(ctx, "task", 0, "file", strings.NewReader("safe"))
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, archiveName("task", v.Revision))
	linked := filepath.Join(root, archiveName("linked", 1))
	if err = os.Symlink(target, linked); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Version(ctx, "linked", 1); err == nil {
		t.Fatal("接受归档符号链接")
	}
	os.Remove(linked)
	if err = os.Link(target, linked); err != nil {
		t.Fatal(err)
	}
	_, err = s.Version(ctx, "task", v.Revision)
	requireCode(t, err, "workspace_unsafe_file")
	os.Remove(linked)
	parent := t.TempDir()
	if err = os.Symlink(root, filepath.Join(parent, "linked")); err != nil {
		t.Fatal(err)
	}
	_, err = Open(filepath.Join(parent, "linked", "child"))
	requireCode(t, err, "workspace_unsafe_root")
	if _, err = os.Stat(filepath.Join(root, "child")); !os.IsNotExist(err) {
		t.Fatalf("链接目标被修改：%v", err)
	}
}

type archiveFile struct {
	name, body, link string
	kind             byte
}

func externalTar(t *testing.T, files ...archiveFile) []byte {
	t.Helper()
	var result bytes.Buffer
	tw := tar.NewWriter(&result)
	for _, entry := range files {
		kind := entry.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		header := &tar.Header{Name: entry.name, Mode: 0o777, Typeflag: kind, Linkname: entry.link, Size: int64(len(entry.body))}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(entry.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func TestWorkspaceArchiveValidation(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t)
	cases := []struct {
		name  string
		files []archiveFile
	}{
		{"symlink", []archiveFile{{name: "link", link: "/etc/passwd", kind: tar.TypeSymlink}}},
		{"hardlink", []archiveFile{{name: "link", link: "file", kind: tar.TypeLink}}},
		{"device", []archiveFile{{name: "dev", kind: tar.TypeChar}}},
		{"absolute", []archiveFile{{name: "/escape", body: "x"}}},
		{"traversal", []archiveFile{{name: "a/../escape", body: "x"}}},
		{"backslash", []archiveFile{{name: "a\\b", body: "x"}}},
		{"duplicate", []archiveFile{{name: "same", body: "x"}, {name: "same", body: "y"}}},
		{"directory-conflict", []archiveFile{{name: "a", body: "x"}, {name: "a/b", body: "y"}}},
		{"directory-conflict-order", []archiveFile{{name: "a/b/", kind: tar.TypeDir}, {name: "a", body: "x"}}},
		{"reserved", []archiveFile{{name: manifestName, body: "{}"}}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, err := s.PrepareImport(ctx, "task", 0, bytes.NewReader(externalTar(t, test.files...))); err == nil {
				t.Fatal("接受不安全归档")
			}
		})
	}
	valid := externalTar(t, archiveFile{name: "nested/", kind: tar.TypeDir}, archiveFile{name: "nested/file", body: "valid"}, archiveFile{name: "empty/", kind: tar.TypeDir})
	v, err := s.PrepareImport(ctx, "task", 0, bytes.NewReader(valid))
	if err != nil || v.FileCount != 1 {
		t.Fatalf("规范目录：%+v %v", v, err)
	}
	data, _, err := s.Read(ctx, "task", v.Revision, "nested/file")
	if err != nil || string(data) != "valid" {
		t.Fatalf("归档偏移：%q %v", data, err)
	}
	for _, invalid := range [][]byte{valid[:800], append(append([]byte(nil), valid...), byte('x')), []byte("not-tar")} {
		if _, err = s.PrepareImport(ctx, "task", v.Revision, bytes.NewReader(invalid)); err == nil {
			t.Fatal("接受损坏归档")
		}
	}
}

func TestWorkspaceQuotaAndPublishFailureLeaveOldVersion(t *testing.T) {
	ctx := context.Background()
	s, root := testStore(t, Options{Limits: Limits{TaskBytes: 8, TaskFiles: 2, GlobalBytes: 1 << 20}})
	base, err := s.PrepareWrite(ctx, "task", 0, "one", strings.NewReader("1234"))
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"123456789", "12345"} {
		_, err = s.PrepareWrite(ctx, "task", base.Revision, "two", strings.NewReader(body))
		requireCode(t, err, "workspace_quota_exceeded")
	}
	_, err = s.PrepareImport(ctx, "task", base.Revision, bytes.NewReader(externalTar(t, archiveFile{name: "1"}, archiveFile{name: "2"}, archiveFile{name: "3"})))
	requireCode(t, err, "workspace_quota_exceeded")
	s.beforePublish = func() error { return errors.New("注入写入失败") }
	_, err = s.PrepareWrite(ctx, "task", base.Revision, "two", strings.NewReader("ok"))
	requireCode(t, err, "workspace_storage_failed")
	s.beforePublish = nil
	data, version, err := s.Read(ctx, "task", base.Revision, "one")
	if err != nil || string(data) != "1234" || version != base {
		t.Fatalf("失败改变旧版本：%q %+v %v", data, version, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".stage-") {
			t.Fatalf("遗留临时文件 %s", entry.Name())
		}
	}
	tiny, _ := testStore(t, Options{Limits: Limits{GlobalBytes: 7000}})
	_, err = tiny.PrepareWrite(ctx, "one", 0, "file", strings.NewReader("x"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = tiny.PrepareWrite(ctx, "two", 0, "file", strings.NewReader(strings.Repeat("x", 4000)))
	requireCode(t, err, "workspace_quota_exceeded")
	if _, err = tiny.Version(ctx, "two", 1); err == nil {
		t.Fatal("配额失败仍发布版本")
	}
}

func TestWorkspaceCanceledReadFailureAndRootReplacement(t *testing.T) {
	s, root := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.PrepareWrite(ctx, "task", 0, "file", strings.NewReader("x"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消：%v", err)
	}
	_, err = s.PrepareWrite(context.Background(), "task", 0, "file", failingReader{})
	requireCode(t, err, "workspace_storage_failed")
	v, err := s.PrepareWrite(context.Background(), "task", 0, "file", strings.NewReader("original"))
	if err != nil {
		t.Fatal(err)
	}
	moved := root + "-original"
	if err = os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	if err = os.Symlink(other, root); err != nil {
		t.Fatal(err)
	}
	data, _, err := s.Read(context.Background(), "task", v.Revision, "file")
	if err != nil || string(data) != "original" {
		t.Fatalf("目录描述符未固定根：%q %v", data, err)
	}
	if _, err = s.PrepareWrite(context.Background(), "task", v.Revision, "next", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(other)
	if err != nil || len(entries) != 0 {
		t.Fatalf("写入替换根：%v %v", entries, err)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("注入读取失败") }

func TestWorkspaceLockWaitHonorsContext(t *testing.T) {
	s, root := testStore(t)
	other, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	release, err := s.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err = other.List(ctx, "task", 0)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("锁取消：%v", err)
	}
}

func TestWorkspaceDiscardDoesNotReuseRevisionAndRemoveIsTaskScoped(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	first, err := s.PrepareWrite(ctx, "task", 0, "file", strings.NewReader("first"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Discard(ctx, "task", first.Revision); err != nil {
		t.Fatal(err)
	}
	second, err := s.PrepareWrite(ctx, "task", 0, "file", strings.NewReader("second"))
	if err != nil || second.Revision <= first.Revision {
		t.Fatalf("版本号被复用：%+v %v", second, err)
	}
	other, err := s.PrepareWrite(ctx, "task-other", 0, "file", strings.NewReader("other"))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.RemoveTask(ctx, "task"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Version(ctx, "task", second.Revision); err == nil {
		t.Fatal("任务版本未清理")
	}
	if v, err := s.Version(ctx, "task-other", other.Revision); err != nil || v != other {
		t.Fatalf("误删其他任务：%+v %v", v, err)
	}
	if err = s.RemoveTask(ctx, "task"); err != nil {
		t.Fatal(err)
	}
}
