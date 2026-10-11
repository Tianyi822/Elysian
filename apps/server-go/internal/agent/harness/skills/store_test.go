package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSkill = "---\nname: test-skill\ndescription: 检查测试资源\nmetadata:\n  author: 测试\n---\n检查指定资源并报告证据。\n"

func fixture(t *testing.T, options Options) (*Store, string, string) {
	t.Helper()
	root := t.TempDir()
	config := filepath.Join(root, "config", "agent-skills.json")
	packages := filepath.Join(root, "data", "skills")
	store, err := Open(config, packages, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return store, config, packages
}
func sourceDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte(testSkill), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}
func awaitImport(t *testing.T, s *Store, id string) ImportTask {
	t.Helper()
	deadline := time.After(5 * time.Second)
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		task, err := s.GetImport(id)
		if err != nil {
			t.Fatal(err)
		}
		if task.State != StateQueued && task.State != StateRunning {
			return task
		}
		select {
		case <-deadline:
			t.Fatal("导入未结束")
		case <-ticker.C:
		}
	}
}
func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var known *Error
	if !errors.As(err, &known) || known.Code != code {
		t.Fatalf("预期 %s，实际 %v", code, err)
	}
}

func TestSkillDirectoryImportVersionsAndNoCredentialLeak(t *testing.T) {
	s, config, _ := fixture(t, Options{})
	source := sourceDir(t)
	input := ImportInput{RequestID: "directory-one", Source: Source{Kind: "directory", Path: source}, Enabled: true}
	task, duplicate, err := s.StartImport(context.Background(), input, nil)
	if err != nil || duplicate {
		t.Fatalf("导入未接受：%v %v", err, duplicate)
	}
	same, duplicate, err := s.StartImport(context.Background(), input, nil)
	if err != nil || !duplicate || same.ID != task.ID {
		t.Fatal("幂等导入未返回同一任务")
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("导入失败：%+v", done)
	}
	original, err := s.Get(done.SkillID, 1, false)
	if err != nil || len(original.Files) != 1 {
		t.Fatalf("读取技能失败：%+v %v", original, err)
	}
	if err = os.WriteFile(filepath.Join(source, "SKILL.md"), []byte(strings.ReplaceAll(testSkill, "检查指定资源", "读取新资源")), 0600); err != nil {
		t.Fatal(err)
	}
	raw, err := s.ReadFile(context.Background(), original.ID, 1, "SKILL.md", 1<<20)
	if err != nil || string(raw) != testSkill {
		t.Fatal("源文件变化修改了已发布技能")
	}
	disabled, err := s.SetEnabled(original.ID, 1, false)
	if err != nil || disabled.Revision != 2 {
		t.Fatalf("停用失败：%v", err)
	}
	_, err = s.Get(original.ID, 1, false)
	requireCode(t, err, "skill-disabled")
	if _, err = s.Get(original.ID, 1, true); err != nil {
		t.Fatal("已接受运行无法读取旧修订")
	}
	_, err = s.SetEnabled(original.ID, 1, true)
	requireCode(t, err, "skill-revision-conflict")
	stat, err := os.Stat(config)
	if err != nil || stat.Mode().Perm() != 0600 {
		t.Fatal("配置权限不是0600")
	}
}

func TestSkillZIPRejectsEscapeLinksDuplicatesAndBudgets(t *testing.T) {
	for _, test := range []struct {
		name  string
		files map[string]string
		limit int64
		code  string
	}{
		{"escape", map[string]string{"../SKILL.md": testSkill}, 0, "invalid-path"},
		{"absolute", map[string]string{"/SKILL.md": testSkill}, 0, "invalid-path"},
		{"backslash", map[string]string{"a\\b": testSkill}, 0, "invalid-path"},
		{"expanded-limit", map[string]string{"SKILL.md": testSkill, "large": strings.Repeat("a", 2048)}, 1024, "skill-size-limit"},
	} {
		t.Run(test.name, func(t *testing.T) {
			options := Options{}
			if test.limit > 0 {
				options.Limits = DefaultLimits()
				options.Limits.PackageBytes = test.limit
			}
			s, _, _ := fixture(t, options)
			task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "zip", Source: Source{Kind: "zip"}}, bytes.NewReader(zipBytes(t, test.files)))
			if err != nil {
				t.Fatal(err)
			}
			done := awaitImport(t, s, task.ID)
			if done.State != StateFailed || done.Error == nil || done.Error.Code != test.code {
				t.Fatalf("无效包被接受：%+v", done)
			}
			list, _ := s.List()
			if len(list) != 0 {
				t.Fatal("失败发布了技能")
			}
		})
	}
	t.Run("symlink", func(t *testing.T) {
		s, _, _ := fixture(t, Options{})
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		header := &zip.FileHeader{Name: "SKILL.md"}
		header.SetMode(os.ModeSymlink | 0777)
		f, _ := writer.CreateHeader(header)
		_, _ = f.Write([]byte("/etc/passwd"))
		_ = writer.Close()
		task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "zip", Source: Source{Kind: "zip"}}, bytes.NewReader(buffer.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		done := awaitImport(t, s, task.ID)
		if done.Error == nil || done.Error.Code != "unsafe-file" {
			t.Fatalf("链接未拒绝：%+v", done)
		}
	})
	t.Run("duplicate", func(t *testing.T) {
		s, _, _ := fixture(t, Options{})
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		for range 2 {
			f, _ := writer.Create("SKILL.md")
			_, _ = f.Write([]byte(testSkill))
		}
		_ = writer.Close()
		task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "zip", Source: Source{Kind: "zip"}}, bytes.NewReader(buffer.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		done := awaitImport(t, s, task.ID)
		if done.Error == nil || done.Error.Code != "duplicate-file" {
			t.Fatalf("重复文件未拒绝：%+v", done)
		}
	})
}

func TestSkillRejectsLinkedLocalPathsAndTamperedPackage(t *testing.T) {
	s, _, root := fixture(t, Options{})
	source := sourceDir(t)
	if err := os.Symlink("/etc/passwd", filepath.Join(source, "linked")); err != nil {
		t.Fatal(err)
	}
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "linked", Source: Source{Kind: "directory", Path: source}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateFailed {
		t.Fatal("本地链接未拒绝")
	}
	_ = os.Remove(filepath.Join(source, "linked"))
	task, _, err = s.StartImport(context.Background(), ImportInput{RequestID: "clean", Source: Source{Kind: "directory", Path: source}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done = awaitImport(t, s, task.ID)
	skill, _ := s.Get(done.SkillID, 1, true)
	if err = os.WriteFile(filepath.Join(root, "packages", skill.Digest, "SKILL.md"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = s.ReadFile(context.Background(), skill.ID, 1, "SKILL.md", 1<<20)
	requireCode(t, err, "skill-content-changed")
}

func TestSkillGitCancellationAndSafeErrors(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	git := func(ctx context.Context, rawURL, ref, credential, destination string, limits Limits) (string, error) {
		if credential != "secret-not-persisted" {
			t.Error("凭据未传给获取器")
		}
		once.Do(func() { close(started) })
		<-ctx.Done()
		return "", errors.New("secret-not-persisted")
	}
	s, config, _ := fixture(t, Options{Git: git})
	input := ImportInput{RequestID: "git", Source: Source{Kind: "git", URL: "https://example.test/repo.git", Ref: "main"}, Credential: "secret-not-persisted"}
	task, _, err := s.StartImport(context.Background(), input, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, err = s.CancelImport(task.ID); err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateCancelled {
		t.Fatalf("取消未确认：%+v", done)
	}
	raw, err := os.ReadFile(config)
	if err != nil || bytes.Contains(raw, []byte("secret-not-persisted")) {
		t.Fatal("凭据进入配置")
	}
	input.Source.URL = "https://user:secret@example.test/repo.git"
	_, _, err = s.StartImport(context.Background(), input, nil)
	requireCode(t, err, "invalid-git-url")
}

func TestSkillConcurrentUpdateLosesNoRevision(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	first, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "first", Source: Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, first.ID)
	entered := make(chan struct{})
	proceed := make(chan struct{})
	s.options.Git = func(ctx context.Context, u, r, c, d string, l Limits) (string, error) {
		close(entered)
		<-proceed
		if err := os.MkdirAll(d, 0700); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte(testSkill), 0600); err != nil {
			return "", err
		}
		return strings.Repeat("a", 40), nil
	}
	second, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "second", SkillID: done.SkillID, ExpectedRevision: 1, Source: Source{Kind: "git", URL: "https://example.test/repo.git", Ref: "main"}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if _, err = s.SetEnabled(done.SkillID, 1, false); err != nil {
		t.Fatal(err)
	}
	close(proceed)
	result := awaitImport(t, s, second.ID)
	if result.State != StateFailed || result.Error.Code != "skill-revision-conflict" {
		t.Fatalf("更新冲突未拒绝：%+v", result)
	}
	latest, _ := s.Get(done.SkillID, 0, true)
	if latest.Revision != 2 || latest.Enabled {
		t.Fatal("并发更新覆盖了停用")
	}
}

func TestSkillReopenInterruptsImportsAndKeepsVersions(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, "config.json")
	packages := filepath.Join(root, "packages")
	s, err := Open(config, packages, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Open(config, packages, Options{}); err == nil {
		t.Fatal("允许并发打开同一存储")
	}
	if err = s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	task := savedImport{ImportTask: ImportTask{ID: randomID("import-"), RequestID: "restart", State: StateRunning}, Input: ImportInput{RequestID: "restart", Source: Source{Kind: "zip"}}}
	raw, _ := json.Marshal(document{Version: 1, Skills: []Skill{}, Imports: []savedImport{task}})
	if err = os.WriteFile(config, raw, 0600); err != nil {
		t.Fatal(err)
	}
	s, err = Open(config, packages, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(context.Background())
	actual, err := s.GetImport(task.ID)
	if err != nil || actual.State != StateInterrupted {
		t.Fatalf("未恢复中断：%+v %v", actual, err)
	}
}

func TestSkillAtomicWriteFailureDoesNotPublish(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	realWrite := s.write
	calls := 0
	s.write = func(path string, doc document) (bool, error) {
		calls++
		if calls == 3 {
			return false, storageError()
		}
		return realWrite(path, doc)
	}
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "atomic", Source: Source{Kind: "directory", Path: source}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = task
	s.wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.doc.Skills) != 0 {
		t.Fatal("失败写入发布了版本")
	}
	raw, err := os.ReadFile(s.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var stored document
	if err = json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored.Skills) != 0 || stored.Imports[0].State != StateRunning {
		t.Fatal("登记发生部分提交")
	}
}

func TestSkillFrontmatterValidation(t *testing.T) {
	for _, raw := range []string{"body", strings.Replace(testSkill, "name: test-skill", "name: Bad_Name", 1), strings.Replace(testSkill, "description: 检查测试资源", "description: ''", 1), strings.Replace(testSkill, "metadata:", "unknown:", 1), "---\nname: test-skill\ndescription: desc\n---\n"} {
		if _, err := parseManifest([]byte(raw)); err == nil {
			t.Fatalf("接受了无效manifest：%q", raw)
		}
	}
	if _, err := parseManifest([]byte(testSkill)); err != nil {
		t.Fatal(err)
	}
}

// 删除登记后磁盘包目录的回收：仅回收「无引用且超过保护期」的摘要目录，
// 被引用的与保护期内的（覆盖导入先落位后登记的无引用窗口）必须保留，
// 非摘要命名的外来目录不动。
func TestPrunePackagesKeepsReferencedAndFreshOrphans(t *testing.T) {
	s, _, packages := fixture(t, Options{})
	packagesRoot := filepath.Join(packages, "packages")
	staleDigest := strings.Repeat("a", 64)
	freshDigest := strings.Repeat("b", 64)
	referencedDigest := strings.Repeat("c", 64)
	for _, digest := range []string{staleDigest, freshDigest, referencedDigest} {
		dir := filepath.Join(packagesRoot, digest)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(testSkill), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stale := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(filepath.Join(packagesRoot, staleDigest), stale, stale); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(packagesRoot, "not-a-digest")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	s.prunePackages(document{Skills: []Skill{{Digest: referencedDigest}}})
	if _, err := os.Lstat(filepath.Join(packagesRoot, staleDigest)); !os.IsNotExist(err) {
		t.Fatal("超期无引用的包目录未被回收")
	}
	if _, err := os.Lstat(filepath.Join(packagesRoot, freshDigest)); err != nil {
		t.Fatalf("保护期内的包目录不应回收：%v", err)
	}
	if _, err := os.Lstat(filepath.Join(packagesRoot, referencedDigest)); err != nil {
		t.Fatalf("被引用的包目录不应回收：%v", err)
	}
	if _, err := os.Lstat(foreign); err != nil {
		t.Fatalf("非摘要命名的外来目录不应被动：%v", err)
	}
}
