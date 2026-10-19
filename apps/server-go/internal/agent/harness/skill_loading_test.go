package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
)

func importReadTestSkill(t *testing.T, f *extensionFixture) skills.Skill {
	t.Helper()
	root := t.TempDir()
	for i := 0; i < 110; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("ref-%03d.md", i)), []byte("中文边界ABCD"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{"SKILL.md": "---\nname: read-test\ndescription: 分页读取验证\n---\n完整正文。\n", "scripts/check.py": "print('ok')", "binary.dat": "\x00\xff", "long.md": strings.Repeat("界", 30000)} {
		if err := os.WriteFile(filepath.Join(root, path), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	task, _, err := f.extensions.Skills.StartImport(context.Background(), skills.ImportInput{RequestID: "reader-package", SkillID: f.skill.ID, ExpectedRevision: f.skill.Revision, Source: skills.Source{Kind: "directory", Path: root}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		task, err = f.extensions.Skills.GetImport(task.ID)
		return err == nil && task.State == skills.StateSucceeded
	})
	pkg, err := f.extensions.Skills.Get(task.SkillID, task.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	return pkg
}

func TestSkillV2PaginationSegmentsAndImmutableIdentity(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	pkg := importReadTestSkill(t, f)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("ok"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "reader-test", Content: "建立固定目录", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	run = runtimeFinished(t, m, run.ID)
	var capability Capability
	for _, c := range run.Snapshot.Tools {
		if c.Source == "skill-load" {
			capability = c
		}
	}
	if strings.Contains(string(capability.Parameters), "ref-000.md") || strings.Contains(string(capability.Parameters), "check.py") {
		t.Fatal("Schema 包含全量路径枚举")
	}
	read := func(args string) CapabilityResult {
		t.Helper()
		result, err := m.executeSkillLoadV2(ctx, *run.Snapshot, Operation{RunID: run.ID, Capability: capability, ArgumentsJSON: args})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := read(`{"action":"list"}`)
	var page struct {
		Files      []skills.File `json:"files"`
		NextOffset int           `json:"nextOffset"`
		Total      int           `json:"total"`
	}
	if json.Unmarshal(first.Value, &page) != nil || len(page.Files) != 50 || page.NextOffset != 50 || page.Total != 114 {
		t.Fatalf("目录分页错误: %s", first.Value)
	}
	second := read(`{"action":"list","offset":50,"limit":100}`)
	if json.Unmarshal(second.Value, &page) != nil || len(page.Files) != 64 {
		t.Fatalf("目录下一页错误: %s", second.Value)
	}
	segment := read(`{"action":"read","path":"ref-000.md","maxBytes":4}`)
	var part struct {
		Text       string `json:"text"`
		NextOffset int    `json:"nextOffset"`
	}
	if json.Unmarshal(segment.Value, &part) != nil || part.Text != "中" || part.NextOffset != 3 {
		t.Fatalf("UTF8 分段错误: %s", segment.Value)
	}
	if next := read(`{"action":"read","path":"ref-000.md","offset":3,"maxBytes":4}`); !strings.Contains(string(next.Value), "文") {
		t.Fatalf("下一片错误: %s", next.Value)
	}
	for _, args := range []string{`{"action":"read","path":"../SKILL.md"}`, `{"action":"read","path":"/SKILL.md"}`, `{"action":"read","path":"./SKILL.md"}`, `{"action":"read","path":"missing"}`, `{"action":"read","path":"ref-000.md","offset":1}`, `{"action":"read","path":"SKILL.md","offset":0}`, `{"action":"read","path":"SKILL.md","maxBytes":4}`} {
		result := read(args)
		if result.BusinessError == nil || result.Context != nil {
			t.Fatalf("错误读取生成了加载身份: %s %+v", args, result)
		}
	}
	binary := read(`{"action":"read","path":"binary.dat"}`)
	if binary.Context != nil || !strings.Contains(string(binary.Value), "非文本资源") {
		t.Fatal("二进制产生加载身份")
	}
	body := read(`{"action":"read","path":"SKILL.md"}`)
	if body.Context == nil || body.BusinessError != nil || !strings.Contains(string(body.Value), "完整正文") {
		t.Fatalf("未完整读取: %+v", body)
	}
	small := *run.Snapshot
	budget := *small.LoadingBudget
	budget.SkillBodyTokens = 1
	small.LoadingBudget = &budget
	denied, err := m.executeSkillLoadV2(ctx, small, Operation{RunID: run.ID, Capability: capability, ArgumentsJSON: `{"action":"read","path":"SKILL.md"}`})
	if err != nil || denied.BusinessError == nil || denied.Context != nil {
		t.Fatal("超预算未返回可纠正失败")
	}
	// 脚本身份由固定文件清单验证，去掉枚举也不能执行参考文件。
	profile := execconfig.Profile{ID: "profile", Revision: 1}
	script := Capability{Source: "script", Ref: capability.Ref}
	snapshot := *run.Snapshot
	snapshot.Profiles = []execconfig.Profile{profile}
	for _, path := range []string{"ref-000.md", "../scripts/check.py", "scripts/missing.py"} {
		args, _ := json.Marshal(scriptArguments{Path: path, ProfileID: profile.ID})
		if _, err = f.extensions.Prepare(ctx, snapshot, Operation{Capability: script, ArgumentsJSON: string(args)}); err == nil {
			t.Fatalf("脚本身份校验放行 %s", path)
		}
	}
	args, _ := json.Marshal(scriptArguments{Path: "scripts/check.py", ProfileID: profile.ID})
	prepared, err := f.extensions.Prepare(ctx, snapshot, Operation{Capability: script, ArgumentsJSON: string(args)})
	if err != nil || prepared.Execution.ScriptDigest == "" {
		t.Fatal("有效脚本缺少固定摘要", err)
	}
	// 篡改参考文件尾部，即使只读取开头也必须拒绝。
	if err = os.WriteFile(filepath.Join(f.packageRoot, "packages", pkg.Digest, "long.md"), []byte(strings.Repeat("界", 29999)+"改"), 0600); err != nil {
		t.Fatal(err)
	}
	changed := read(`{"action":"read","path":"long.md","maxBytes":4}`)
	if changed.BusinessError == nil || changed.BusinessError.Code != "skill-content-changed" || changed.Context != nil {
		t.Fatal("分段读取绕过完整摘要校验")
	}
}
