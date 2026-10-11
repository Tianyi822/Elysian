package skills

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 技能文件路径必须拒绝不可见与方向控制字符，防止恶意文件名在人审与模型可见清单中视觉混淆。
func TestSkillPathRejectsInvisibleAndDirectionalRunes(t *testing.T) {
	for _, value := range []string{
		"scripts/\u202Erun.sh",     // RTL 覆盖符
		"references/zero\u200B.md", // 零宽空格
		"bom\uFEFF.txt",            // 字节顺序标记
		"nbsp\u00A0name.txt",       // 不换行空格
		"del\x7F.txt",              // DEL 控制符
		"private\uE000.txt",        // 私用区码点
	} {
		_, err := cleanRelative(value)
		if err == nil {
			t.Fatalf("接受了不可见字符路径：%q", value)
		}
		requireCode(t, err, "invalid-path")
	}
	for _, value := range []string{"references/说明.md", "scripts/run.sh", "a b.txt"} {
		if _, err := cleanRelative(value); err != nil {
			t.Fatalf("拒绝了正常路径 %q：%v", value, err)
		}
	}
}

// 技能 ZIP 中的视觉混淆文件名必须在导入时被拒绝，正常中文与空格文件名不应被误伤。
func TestSkillZIPRejectsConfusableFilenames(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	archive := zipBytes(t, map[string]string{"SKILL.md": testSkill, "\u202EREADME.md": "内容"})
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "confusable", Source: Source{Kind: "zip"}}, bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateFailed || done.Error == nil || done.Error.Code != "invalid-path" {
		t.Fatalf("混淆文件名未被拒绝：%+v", done)
	}
	if list, _ := s.List(); len(list) != 0 {
		t.Fatal("失败发布了技能")
	}
}

func TestSkillChineseAndSpaceFilenamesStillImport(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	if err := os.WriteFile(filepath.Join(source, "参考资料 说明.md"), []byte("资料"), 0600); err != nil {
		t.Fatal(err)
	}
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "readable", Source: Source{Kind: "directory", Path: source}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("正常中文路径导入失败：%+v", done)
	}
}

// 技能 description 直接拼入模型可见的工具描述，不得包含不可见或方向控制字符。
func TestSkillManifestRejectsInvisibleDescription(t *testing.T) {
	for _, description := range []string{"正常\u202E反转", "隐藏\u200B字符", "不换行\u00A0空格"} {
		raw := strings.Replace(testSkill, "检查测试资源", description, 1)
		if _, err := parseManifest([]byte(raw)); err == nil {
			t.Fatalf("接受了不可见字符描述：%q", description)
		}
	}
}

// 确定性的登记容量拒绝未写盘也没有存储不确定性，不应把整个存储置为不可用而连只读操作都拒绝。
func TestSkillConfigLimitKeepsReadsAvailable(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "capacity", Source: Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("导入未成功：%+v", done)
	}
	s.write = func(string, document) (bool, error) {
		return false, problem(409, "skill-config-limit", "技能登记容量达到上限")
	}
	_, err = s.SetEnabled(done.SkillID, 1, false)
	requireCode(t, err, "skill-config-limit")
	if _, err = s.GetImport(task.ID); err != nil {
		t.Fatalf("容量拒绝后导入记录不可读：%v", err)
	}
	list, err := s.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("容量拒绝后技能清单不可读：%v %d", err, len(list))
	}
	if _, err = s.Get(done.SkillID, 1, true); err != nil {
		t.Fatalf("容量拒绝后旧修订不可读：%v", err)
	}
}

// 真实存储故障仍必须把存储置为不可用，不能因错误分类修复而放宽。
func TestSkillStorageFailureStillMarksUnavailable(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "storage", Source: Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("导入未成功：%+v", done)
	}
	s.write = func(string, document) (bool, error) {
		return false, storageError()
	}
	_, err = s.SetEnabled(done.SkillID, 1, false)
	requireCode(t, err, "skill-storage")
	_, err = s.List()
	requireCode(t, err, "skill-storage")
}

// 登记容量触顶后删除必须仍是可用的自救入口：删除产出更小的登记文件，
// 写盘上限只拒绝增长，不拒绝收缩，管理员无需停面板手工编辑 0600 配置。
func TestSkillDeleteRecoversFromConfigLimit(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	source := sourceDir(t)
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "rescue", Source: Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("导入未成功：%+v", done)
	}
	realWrite := s.write
	// 模拟登记文件已到写盘上限：只要该技能的登记条目还存在于文档，落盘一律被拒绝。
	s.write = func(path string, doc document) (bool, error) {
		for _, entry := range doc.Skills {
			if entry.ID == done.SkillID {
				return false, problem(409, "skill-config-limit", "技能登记容量达到上限")
			}
		}
		return realWrite(path, doc)
	}
	_, err = s.SetEnabled(done.SkillID, 1, false)
	requireCode(t, err, "skill-config-limit")
	deleted, err := s.Delete(done.SkillID, 1)
	if err != nil || deleted.ID != done.SkillID {
		t.Fatalf("触顶后删除失败：%v %+v", err, deleted)
	}
	list, err := s.List()
	if err != nil || len(list) != 0 {
		t.Fatalf("删除后技能仍在清单：%v %d", err, len(list))
	}
	if _, err = s.Get(done.SkillID, 1, true); err == nil {
		t.Fatal("删除后旧修订仍可读")
	}
	_, err = s.Delete(done.SkillID, 1)
	requireCode(t, err, "skill-not-found")
}

// 导入记录按条数滚动保留：超过保留条数后最旧的终态记录被淘汰，新近记录仍在。
func TestSkillImportHistoryRollsTerminalRecords(t *testing.T) {
	options := Options{}
	options.Limits = DefaultLimits()
	options.Limits.ImportHistory = 2
	s, _, _ := fixture(t, options)
	var ids []string
	for i := range 4 {
		archive := zipBytes(t, map[string]string{"SKILL.md": strings.Replace(testSkill, "检查测试资源", fmt.Sprintf("检查测试资源 %d", i), 1)})
		task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: fmt.Sprintf("roll-%d", i), Source: Source{Kind: "zip"}}, bytes.NewReader(archive))
		if err != nil {
			t.Fatal(err)
		}
		done := awaitImport(t, s, task.ID)
		if done.State != StateSucceeded {
			t.Fatalf("导入未成功：%+v", done)
		}
		ids = append(ids, done.ID)
	}
	for _, id := range ids[:2] {
		_, err := s.GetImport(id)
		requireCode(t, err, "import-not-found")
	}
	for _, id := range ids[2:] {
		if _, err := s.GetImport(id); err != nil {
			t.Fatalf("新近导入记录被误删：%v", err)
		}
	}
}

// 滚动收缩只能淘汰终态记录：最旧记录仍在进行时暂缓收缩，不得越过它删更旧的之后又删新记录。
func TestSkillPruneKeepsActiveImports(t *testing.T) {
	s, _, _ := fixture(t, Options{})
	s.options.Limits.ImportHistory = 1
	next := document{Version: 1, Imports: []savedImport{
		{ImportTask: ImportTask{ID: randomID("import-"), State: StateSucceeded}},
		{ImportTask: ImportTask{ID: randomID("import-"), State: StateRunning}},
		{ImportTask: ImportTask{ID: randomID("import-"), State: StateSucceeded}},
	}}
	s.pruneImports(&next)
	if len(next.Imports) != 2 || next.Imports[0].State != StateRunning {
		t.Fatalf("收缩误删了进行中的记录：%+v", next.Imports)
	}
}

// 管理员可删除已达终态的导入记录收缩登记；进行中的任务不可删除。
func TestSkillDeleteImportRecordRequiresTerminalState(t *testing.T) {
	entered := make(chan struct{})
	proceed := make(chan struct{})
	git := func(ctx context.Context, rawURL, ref, credential, destination string, limits Limits) (string, error) {
		close(entered)
		<-proceed
		if err := os.MkdirAll(destination, 0700); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(destination, "SKILL.md"), []byte(testSkill), 0600); err != nil {
			return "", err
		}
		return strings.Repeat("a", 40), nil
	}
	s, _, _ := fixture(t, Options{Git: git})
	task, _, err := s.StartImport(context.Background(), ImportInput{RequestID: "record", Source: Source{Kind: "git", URL: "https://example.test/repo.git", Ref: "main"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	_, err = s.DeleteImport(task.ID)
	requireCode(t, err, "import-not-finished")
	close(proceed)
	done := awaitImport(t, s, task.ID)
	if done.State != StateSucceeded {
		t.Fatalf("导入未成功：%+v", done)
	}
	removed, err := s.DeleteImport(task.ID)
	if err != nil || removed.ID != task.ID {
		t.Fatalf("终态记录删除失败：%v", err)
	}
	_, err = s.GetImport(task.ID)
	requireCode(t, err, "import-not-found")
	_, err = s.DeleteImport(task.ID)
	requireCode(t, err, "import-not-found")
}
