package containerapps

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/paths"
)

func newTestHandler(t *testing.T) (Handler, string) {
	t.Helper()
	mountRoot := t.TempDir()
	registryPath := filepath.Join(t.TempDir(), "container-apps.json")
	registry := &Registry{MountRoot: mountRoot, RegistryPath: registryPath}
	return Handler{Registry: registry, Time: func() time.Time { return time.Date(2026, 10, 4, 8, 0, 0, 0, time.UTC) }}, mountRoot
}

// testOrigin 与 Host 一致且命中回环名单，才过得去 SameOriginGuard（写请求守卫）。
const testOrigin = "http://127.0.0.1:48101"

func do(t *testing.T, h Handler, method, target, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, testOrigin+target, bytes.NewReader(body))
	request.Header.Set("Origin", testOrigin)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.ContentLength = int64(len(body))
	recorder := httptest.NewRecorder()
	h.Router().ServeHTTP(recorder, request)
	return recorder
}

// --- 标识与路径校验 ---

func TestSlugValidationRejectsEscapesAndShapes(t *testing.T) {
	rejected := []string{"", ".", "..", "../etc", "Aaaa", "a/b", "a b", "a\\b", strings.Repeat("a", 65), "-start", "_start"}
	for _, slug := range rejected {
		if err := ValidateSlug(slug); err == nil {
			t.Errorf("标识 %q 应被拒绝", slug)
		}
	}
	for _, slug := range []string{"grafana", "a1", "my_app-2", strings.Repeat("z", 64)} {
		if err := ValidateSlug(slug); err != nil {
			t.Errorf("标识 %q 应通过：%v", slug, err)
		}
	}
}

func TestNormalizeRelativeRejectsTraversalAndAbsolute(t *testing.T) {
	rejected := []string{"", "/", "/etc/passwd", "../x", "a/../../b", "a//b", "a/./b", "a/", "a\\b", "a/\x00b", strings.Repeat("a/", 12) + "x"}
	for _, rel := range rejected {
		if _, err := NormalizeRelative(rel); err == nil {
			t.Errorf("相对路径 %q 应被拒绝", rel)
		}
	}
	for _, rel := range []string{"compose.yml", "config/app.yml", "a/b/c.env"} {
		got, err := NormalizeRelative(rel)
		if err != nil || got != rel {
			t.Errorf("相对路径 %q 应通过且原样归一：%q %v", rel, got, err)
		}
	}
}

func TestResolveWithinWorkspaceBlocksSymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dir, "link.txt")); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	// 符号链接本身作为路径段被拒绝不了，但目标解析后必须仍在工作区内。
	if _, err := resolveWithinWorkspace(dir, "sub/../../etc/passwd"); err == nil {
		t.Fatal("归一化前的上级路径必须被拒")
	}
	target, err := resolveWithinWorkspace(dir, "link.txt")
	if err != nil {
		t.Fatalf("link.txt 应通过归一化（逃逸由 realpath 复核拦）：%v", err)
	}
	if filepath.Dir(target) != dir {
		t.Fatalf("拼接结果不应改变所在目录：%s", target)
	}
	if err = AssertWithin(dir, outside); err == nil {
		t.Fatal("解析到工作区外的路径必须被 AssertWithin 拦下")
	}
}

// --- 登记与工作区生命周期 ---

func TestCreateListDeleteRoundTrip(t *testing.T) {
	handler, mountRoot := newTestHandler(t)

	created := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"grafana","displayName":"监控栈"}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("新建应 201，实际 %d %s", created.Code, created.Body.String())
	}
	if !strings.Contains(created.Body.String(), filepath.Join(mountRoot, "elysian", "apps", "grafana")) {
		t.Fatalf("响应应带真实绝对路径：%s", created.Body.String())
	}
	if _, err := os.Stat(filepath.Join(mountRoot, "elysian", "apps", "grafana")); err != nil {
		t.Fatalf("目录应已建出：%v", err)
	}

	duplicate := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"grafana","displayName":"再来一个"}`))
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("重名应 409，实际 %d", duplicate.Code)
	}

	listed := do(t, handler, "GET", "/", "", nil)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"slug":"grafana"`) {
		t.Fatalf("列表应含该工作区：%d %s", listed.Code, listed.Body.String())
	}

	removed := do(t, handler, "DELETE", "/grafana/", "", nil)
	if removed.Code != http.StatusNoContent {
		t.Fatalf("删除应 204，实际 %d", removed.Code)
	}
	if _, err := os.Stat(filepath.Join(mountRoot, "elysian", "apps", "grafana")); !os.IsNotExist(err) {
		t.Fatal("删除应连带移除目录")
	}
}

func TestCreateRejectsUnknownFieldAndBadDisplayName(t *testing.T) {
	handler, _ := newTestHandler(t)
	unknown := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"a","displayName":"b","extra":1}`))
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("多余字段应 400，实际 %d", unknown.Code)
	}
	bad := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"a","displayName":"$(rm -rf /)"}`))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("展示名字符不符应 400，实际 %d %s", bad.Code, bad.Body.String())
	}
}

func TestRegistryCorruptionFailsLoudly(t *testing.T) {
	handler, _ := newTestHandler(t)
	if code := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"a","displayName":"a"}`)).Code; code != http.StatusCreated {
		t.Fatalf("前置新建失败：%d", code)
	}
	if err := os.WriteFile(handler.Registry.registryPath(), []byte("{ not json"), 0600); err != nil {
		t.Fatal(err)
	}
	listed := do(t, handler, "GET", "/", "", nil)
	if listed.Code != http.StatusInternalServerError {
		t.Fatalf("登记表损坏不得当成空表，应 500，实际 %d", listed.Code)
	}
	if !strings.Contains(listed.Body.String(), "损坏") {
		t.Fatalf("应说明登记表损坏：%s", listed.Body.String())
	}
}

func TestCreateRefusesToAdoptForeignDirectory(t *testing.T) {
	handler, mountRoot := newTestHandler(t)
	foreign := filepath.Join(mountRoot, "elysian", "apps", "someone-else")
	if err := os.MkdirAll(foreign, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "keep.txt"), []byte("mine"), 0600); err != nil {
		t.Fatal(err)
	}
	created := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"someone-else","displayName":"别人的"}`))
	if created.Code != http.StatusConflict {
		t.Fatalf("不应接管来历不明的目录，应 409，实际 %d %s", created.Code, created.Body.String())
	}
	if _, err := os.Stat(filepath.Join(foreign, "keep.txt")); err != nil {
		t.Fatal("既有文件不得被动过")
	}
}

// --- 上传与内容读写 ---

func TestUploadReadWriteDelete(t *testing.T) {
	handler, _ := newTestHandler(t)
	if code := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"app","displayName":"应用"}`)).Code; code != http.StatusCreated {
		t.Fatalf("前置新建失败：%d", code)
	}

	uploaded := do(t, handler, "PUT", "/app/files?path=config/app.yml", "application/octet-stream", []byte("key: value\n"))
	if uploaded.Code != http.StatusOK {
		t.Fatalf("上传应 200，实际 %d %s", uploaded.Code, uploaded.Body.String())
	}
	if _, err := os.Stat(filepath.Join(handler.Registry.MountRoot, "elysian", "apps", "app", "config", "app.yml")); err != nil {
		t.Fatalf("嵌套相对路径应落盘：%v", err)
	}

	read := do(t, handler, "GET", "/app/content?path=config/app.yml", "", nil)
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), `key: value`) {
		t.Fatalf("读取应回全文：%d %s", read.Code, read.Body.String())
	}

	written := do(t, handler, "PUT", "/app/content?path=config/app.yml", "text/plain", []byte("key: changed\n"))
	if written.Code != http.StatusOK {
		t.Fatalf("写入应 200，实际 %d %s", written.Code, written.Body.String())
	}
	after, err := os.ReadFile(filepath.Join(handler.Registry.MountRoot, "elysian", "apps", "app", "config", "app.yml"))
	if err != nil || !strings.Contains(string(after), "changed") {
		t.Fatalf("写入未生效：%s %v", after, err)
	}

	deleted := do(t, handler, "DELETE", "/app/files?path=config/app.yml", "", nil)
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("删除文件应 204，实际 %d", deleted.Code)
	}
	if again := do(t, handler, "GET", "/app/content?path=config/app.yml", "", nil); again.Code != http.StatusNotFound {
		t.Fatalf("删后再读应 404，实际 %d", again.Code)
	}
}

func TestUploadRejectsWrongContentTypeTraversalAndOversize(t *testing.T) {
	handler, _ := newTestHandler(t)
	if code := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"app","displayName":"应用"}`)).Code; code != http.StatusCreated {
		t.Fatalf("前置新建失败：%d", code)
	}

	wrongType := do(t, handler, "PUT", "/app/files?path=a.txt", "text/plain", []byte("x"))
	if wrongType.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("上传 Content-Type 不符应 415，实际 %d", wrongType.Code)
	}
	traversal := do(t, handler, "PUT", "/app/files?path=../../etc/passwd", "application/octet-stream", []byte("x"))
	if traversal.Code != http.StatusBadRequest {
		t.Fatalf("穿越路径应 400，实际 %d %s", traversal.Code, traversal.Body.String())
	}
	absolute := do(t, handler, "PUT", "/app/files?path=/etc/passwd", "application/octet-stream", []byte("x"))
	if absolute.Code != http.StatusBadRequest {
		t.Fatalf("绝对路径应 400，实际 %d", absolute.Code)
	}

	oversize := make([]byte, maxFileBytes+1)
	tooBig := do(t, handler, "PUT", "/app/files?path=big.bin", "application/octet-stream", oversize)
	if tooBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超过单文件上限应 413，实际 %d", tooBig.Code)
	}
	mismatch := do(t, handler, "PUT", "/app/files?path=short.txt", "application/octet-stream", []byte("abc"))
	if mismatch.Code != http.StatusOK {
		t.Fatalf("申报与实读一致时应成功，实际 %d %s", mismatch.Code, mismatch.Body.String())
	}
}

func TestContentEditingRejectsBinaryAndOversize(t *testing.T) {
	handler, _ := newTestHandler(t)
	if code := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"app","displayName":"应用"}`)).Code; code != http.StatusCreated {
		t.Fatalf("前置新建失败：%d", code)
	}
	dir := filepath.Join(handler.Registry.MountRoot, "elysian", "apps", "app")
	if err := os.WriteFile(filepath.Join(dir, "blob.bin"), []byte("head\x00tail"), 0600); err != nil {
		t.Fatal(err)
	}
	binary := do(t, handler, "GET", "/app/content?path=blob.bin", "", nil)
	if binary.Code != http.StatusBadRequest || !strings.Contains(binary.Body.String(), "UTF-8") {
		t.Fatalf("二进制应被拒且说明原因，实际 %d %s", binary.Code, binary.Body.String())
	}
	writeBinary := do(t, handler, "PUT", "/app/content?path=x.txt", "text/plain", []byte("a\x00b"))
	if writeBinary.Code == http.StatusOK {
		t.Fatal("含 NUL 的编辑内容不得写入")
	}
	oversize := do(t, handler, "PUT", "/app/content?path=x.txt", "text/plain", bytes.Repeat([]byte("a"), int(maxTextBytes)+1))
	if oversize.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超过文本上限应 413，实际 %d", oversize.Code)
	}
}

func TestUnknownWorkspaceAndUnknownRoute(t *testing.T) {
	handler, _ := newTestHandler(t)
	if code := do(t, handler, "GET", "/nope/files", "", nil).Code; code != http.StatusNotFound {
		t.Fatalf("未知工作区应 404，实际 %d", code)
	}
	badSlug := do(t, handler, "GET", "/../etc/files", "", nil)
	if badSlug.Code == http.StatusOK {
		t.Fatal("非法标识不得成功")
	}
}

// --- compose 自检 ---

func TestCheckComposeClassifiesReferences(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config", "exists.yml"), []byte("a: 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	content := strings.Join([]string{
		"services:",
		"  app:",
		"    env_file: .env",
		"    volumes:",
		"      - ./config/exists.yml:/etc/app.yml:ro",
		"      - ./config/missing.yml:/etc/missing.yml",
		"      - named-volume:/data",
		"      - /absolute/path:/inside",
		"      - ./dynamic/${TAG}:/x",
		"    build:",
		"      context: .",
	}, "\n")

	result, err := CheckCompose(dir, "compose.yml", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.References) != 2 {
		t.Fatalf("应只判定出两条工作区相对引用，实际 %+v", result.References)
	}
	if !result.References[0].Exists || result.References[0].Path != "config/exists.yml" {
		t.Fatalf("已存在的引用判定错：%+v", result.References[0])
	}
	if result.References[1].Exists || result.References[1].Path != "config/missing.yml" {
		t.Fatalf("缺失的引用应报不存在：%+v", result.References[1])
	}
	if result.References[1].Kind != KindEnvFile && result.References[1].Kind != KindVolume {
		t.Fatalf("引用类型异常：%+v", result.References[1])
	}
	joined := strings.Join(result.Undetermined, "\n")
	// env_file 的 .env 不在磁盘上：它既不是 ./ 开头也不是绝对路径，按命名卷跳过，
	// 因此未判定清单里只应出现变量、绝对路径与 build 三类。
	if !strings.Contains(joined, "${TAG}") {
		t.Errorf("变量替换的行应进未判定清单：%s", joined)
	}
	if !strings.Contains(joined, "/absolute/path") {
		t.Errorf("绝对路径引用应进未判定清单：%s", joined)
	}
	if !strings.Contains(joined, "build") {
		t.Errorf("build 段应进未判定清单并说明本轮不构建：%s", joined)
	}
	if result.Coverage == "" {
		t.Error("必须回传判定范围说明，不能让界面把它当成全量解析")
	}
}

func TestCheckComposeEnvFileListAndAmbiguous(t *testing.T) {
	dir := t.TempDir()
	content := strings.Join([]string{
		"services:",
		"  app:",
		"    env_file:",
		"      - base.env",
		"      - ./real.env",
	}, "\n")
	if err := os.WriteFile(filepath.Join(dir, "real.env"), []byte("A=1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := CheckCompose(dir, "compose.yml", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.References) != 1 || result.References[0].Kind != KindEnvFile || !result.References[0].Exists {
		t.Fatalf("env_file 列表项应只判定 ./real.env：%+v", result.References)
	}
}

// 跨语言锚定：这条 fixture 与 web 侧 containerAdapterContract.ts 的
// 「checkCompose 报出缺失与已存在的引用」逐字相同，两侧必须给出同一分类结论。
// Go 与 TS 各有一份扫描器（跨语言无法共享代码），漂移只能靠这条共同样本暴露。
func TestCheckComposeMatchesWebContractFixture(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "real.env"), []byte("A=1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	content := "services:\n  app:\n    env_file:\n      - ./real.env\n      - ./missing.env\n      - /abs/path\n"
	result, err := CheckCompose(dir, "compose.yml", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.References) != 2 {
		t.Fatalf("应判定出两条引用：%+v", result.References)
	}
	got := [][2]any{
		{result.References[0].Path, result.References[0].Exists},
		{result.References[1].Path, result.References[1].Exists},
	}
	want := [][2]any{{"real.env", true}, {"missing.env", false}}
	for i := range want {
		if got[i][0] != want[i][0] || got[i][1] != want[i][1] {
			t.Fatalf("第 %d 条引用分类与 web 侧不一致：got %v want %v", i+1, got[i], want[i])
		}
	}
	if !strings.Contains(strings.Join(result.Undetermined, "\n"), "/abs/path") {
		t.Fatalf("绝对路径应进未判定清单：%v", result.Undetermined)
	}
	if result.Coverage == "" {
		t.Fatal("必须回传判定范围说明")
	}
}

func TestCheckComposeRejectsBadPathArgument(t *testing.T) {
	if _, err := CheckCompose(t.TempDir(), "../escape", "services: {}"); err == nil {
		t.Fatal("compose 自身路径越界必须报错")
	}
}

// 守卫：实体目录必须在 mountRoot 下而不在 ~/.Elysian 下——回显给用户的路径要在
// 宿主、面板与 Docker daemon 三方是同一个字符串，而 ~/.Elysian 在 Docker 部署里
// 是命名卷挂到 /var/lib/elysian 再软链回来的，两侧不一致。
func TestWorkspaceLivesUnderMountRootNotElysianHome(t *testing.T) {
	handler, mountRoot := newTestHandler(t)
	if code := do(t, handler, "POST", "/", "application/json", []byte(`{"slug":"where","displayName":"在哪"}`)).Code; code != http.StatusCreated {
		t.Fatalf("前置新建失败：%d", code)
	}
	response := do(t, handler, "GET", "/", "", nil).Body.String()
	expected := filepath.Join(mountRoot, "elysian", "apps", "where")
	if _, err := os.Stat(expected); err != nil {
		t.Fatalf("实体必须落在 mountRoot 下：%v", err)
	}
	if strings.Contains(response, paths.ElysianHome) {
		t.Fatalf("回显路径不得指向 ~/.Elysian：%s", response)
	}
}
