package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 凭据文件测试（credentialsStore.test.ts 对等用例）：注入临时目录，锚定 JSON 形状、
// 0600/0700 权限、直读不缓存（CLI 改密被 server 下一次 Current 感知的行为锚点）与
// fail closed。首启保障用注入的打印函数断言横幅与跳过语义，不真打 stdout。

const testEpoch = "2026-09-30T00:00:00.000Z"

func tempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "elysian-auth-test-*")
	if err != nil {
		t.Fatalf("建临时目录失败：%v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func writePrivate(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写文件失败：%v", err)
	}
}

func TestFileCredentialsMissingReturnsNil(t *testing.T) {
	dir := tempDir(t)
	store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
	current, err := store.Current()
	if err != nil {
		t.Fatalf("Current 报错：%v", err)
	}
	if current != nil {
		t.Errorf("文件缺失时 Current() = %v，期望 nil", current)
	}
}

func TestFileCredentialsWriteShapeAndReadBack(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "config", "panel-credentials.json")
	store := NewFileCredentialsStore(path)
	written, err := store.Write("scrypt:16384:8:1:AAAA:BBBB")
	if err != nil {
		t.Fatalf("Write 失败：%v", err)
	}
	if written.Username != "admin" {
		t.Errorf("written.Username = %q，期望 admin", written.Username)
	}
	if written.PasswordHash != "scrypt:16384:8:1:AAAA:BBBB" {
		t.Errorf("written.PasswordHash = %q", written.PasswordHash)
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(written.PasswordChangedAt) {
		t.Errorf("passwordChangedAt 不是毫秒精度 ISO 串：%q", written.PasswordChangedAt)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读落盘文件失败：%v", err)
	}
	var onDisk map[string]any
	if err := json.Unmarshal(data, &onDisk); err != nil {
		t.Fatalf("落盘 JSON 解析失败：%v", err)
	}
	if onDisk["version"] != float64(1) || onDisk["username"] != "admin" ||
		onDisk["passwordHash"] != "scrypt:16384:8:1:AAAA:BBBB" || onDisk["passwordChangedAt"] != written.PasswordChangedAt {
		t.Errorf("落盘形状不符：%s", data)
	}
	current, err := store.Current()
	if err != nil {
		t.Fatalf("Current 报错：%v", err)
	}
	if current == nil || *current != *written {
		t.Errorf("Current() = %v，期望 %v", current, written)
	}
}

func TestFileCredentialsWritePermissions(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "config", "panel-credentials.json")
	store := NewFileCredentialsStore(path)
	if _, err := store.Write("scrypt:16384:8:1:AAAA:BBBB"); err != nil {
		t.Fatalf("Write 失败：%v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("文件权限 = %o，期望 0600", fi.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat 目录失败：%v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("目录权限 = %o，期望 0700", dirInfo.Mode().Perm())
	}
}

func TestFileCredentialsSecondWriteAdvancesEpoch(t *testing.T) {
	dir := tempDir(t)
	store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
	first, err := store.Write("scrypt:16384:8:1:AAAA:BBBB")
	if err != nil {
		t.Fatalf("第一次 Write 失败：%v", err)
	}
	time.Sleep(5 * time.Millisecond)
	second, err := store.Write("scrypt:16384:8:1:CCCC:DDDD")
	if err != nil {
		t.Fatalf("第二次 Write 失败：%v", err)
	}
	if second.PasswordHash != "scrypt:16384:8:1:CCCC:DDDD" {
		t.Errorf("second.PasswordHash = %q", second.PasswordHash)
	}
	if second.PasswordChangedAt <= first.PasswordChangedAt {
		t.Errorf("passwordChangedAt 未推进：%q → %q", first.PasswordChangedAt, second.PasswordChangedAt)
	}
}

func TestFileCredentialsNoCacheDirectRead(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "config", "panel-credentials.json")
	store := NewFileCredentialsStore(path)
	mine, err := store.Write("scrypt:16384:8:1:AAAA:BBBB")
	if err != nil {
		t.Fatalf("Write 失败：%v", err)
	}

	// CLI 改密等价于另一个进程写同一文件（passwordChangedAt 推进、哈希更换）。
	external := PanelCredentials{
		Username:          mine.Username,
		PasswordHash:      "scrypt:16384:8:1:EEEE:FFFF",
		PasswordChangedAt: "2026-10-01T00:00:00.000Z",
	}
	externalBytes, _ := json.Marshal(credentialsFile{Version: 1, Username: external.Username, PasswordHash: external.PasswordHash, PasswordChangedAt: external.PasswordChangedAt})
	writePrivate(t, path, string(externalBytes))

	current, err := store.Current()
	if err != nil {
		t.Fatalf("Current 报错：%v", err)
	}
	if current == nil || *current != external {
		t.Errorf("外部改写后 Current() = %v，期望 %v（无缓存直读）", current, external)
	}
}

func TestFileCredentialsFailClosed(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "config", "panel-credentials.json")
	store := NewFileCredentialsStore(path)

	valid := `{"version":1,"username":"admin","passwordHash":"x","passwordChangedAt":"2026-09-30T00:00:00.000Z"}`
	cases := []struct {
		name    string
		content string
		chmod   os.FileMode
	}{
		{"坏 JSON", "{not-json", 0o600},
		{"缺字段", `{"version":1,"username":"admin"}`, 0o600},
		{"版本不符", `{"version":2,"username":"admin","passwordHash":"x","passwordChangedAt":"2026-09-30T00:00:00.000Z"}`, 0o600},
		{"权限放宽", valid, 0o644},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			writePrivate(t, path, tc.content)
			if err := os.Chmod(path, tc.chmod); err != nil {
				t.Fatalf("chmod 失败：%v", err)
			}
			current, err := store.Current()
			if err != nil {
				t.Fatalf("Current 报错：%v（fail closed 不抛）", err)
			}
			if current != nil {
				t.Errorf("%s：Current() = %v，期望 nil", tc.name, current)
			}
		})
	}
}

func TestFileCredentialsSymlinkFinalComponentFailClosed(t *testing.T) {
	dir := tempDir(t)
	target := filepath.Join(dir, "target.json")
	writePrivate(t, target, `{"version":1,"username":"admin","passwordHash":"x","passwordChangedAt":"2026-09-30T00:00:00.000Z"}`)
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("建符号链接失败：%v", err)
	}
	store := NewFileCredentialsStore(link)
	current, err := store.Current()
	if err != nil {
		t.Fatalf("Current 报错：%v", err)
	}
	if current != nil {
		t.Error("最终组件是符号链接时 Current() 应回 nil（O_NOFOLLOW）")
	}
}

func TestMemoryCredentialsStore(t *testing.T) {
	store := NewMemoryCredentialsStore(nil)
	current, err := store.Current()
	if err != nil || current != nil {
		t.Errorf("缺省 Current() = (%v, %v)，期望 (nil, nil)", current, err)
	}
	written, err := store.Write("scrypt:16384:8:1:AAAA:BBBB")
	if err != nil {
		t.Fatalf("Write 失败：%v", err)
	}
	current, err = store.Current()
	if err != nil || current == nil || *current != *written {
		t.Errorf("Write 后 Current() = (%v, %v)，期望 %v", current, err, written)
	}
}

func TestMemoryCredentialsStoreDeepCopy(t *testing.T) {
	initial := PanelCredentials{Username: "admin", PasswordHash: "h", PasswordChangedAt: testEpoch}
	store := NewMemoryCredentialsStore(&initial)
	initial.PasswordHash = "mutated"
	current, err := store.Current()
	if err != nil {
		t.Fatalf("Current 报错：%v", err)
	}
	if current == nil || current.PasswordHash != "h" {
		t.Errorf("外部改动初始值影响了内部：Current() = %v", current)
	}
}

func TestEnsureFirstBootDevSkipped(t *testing.T) {
	dir := tempDir(t)
	store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
	var printed []string
	outcome, err := ensureFirstBootCredentials(store, firstBootOptions{dev: true, print: func(line string) { printed = append(printed, line) }})
	if err != nil {
		t.Fatalf("ensureFirstBootCredentials 失败：%v", err)
	}
	if outcome != FirstBootDevSkipped {
		t.Errorf("outcome = %v，期望 FirstBootDevSkipped", outcome)
	}
	current, err := store.Current()
	if err != nil || current != nil {
		t.Errorf("dev 开时不应生成文件：Current() = (%v, %v)", current, err)
	}
	if len(printed) != 1 || printed[0] != AuthDevWarning {
		t.Errorf("printed = %v，期望仅一行 %q", printed, AuthDevWarning)
	}
}

func TestEnsureFirstBootAlreadyPresent(t *testing.T) {
	dir := tempDir(t)
	store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
	created, err := store.Write("scrypt:16384:8:1:AAAA:BBBB")
	if err != nil {
		t.Fatalf("预写凭据失败：%v", err)
	}
	var printed []string
	outcome, err := ensureFirstBootCredentials(store, firstBootOptions{dev: false, print: func(line string) { printed = append(printed, line) }})
	if err != nil {
		t.Fatalf("ensureFirstBootCredentials 失败：%v", err)
	}
	if outcome != FirstBootAlreadyPresent {
		t.Errorf("outcome = %v，期望 FirstBootAlreadyPresent", outcome)
	}
	if len(printed) != 0 {
		t.Errorf("已存在时不应打印，printed = %v", printed)
	}
	current, err := store.Current()
	if err != nil || current == nil || *current != *created {
		t.Errorf("已存在时凭据保持原样：Current() = (%v, %v)", current, err)
	}
}

func TestEnsureFirstBootConcurrentRunsCreateOnePassword(t *testing.T) {
	store := NewFileCredentialsStore(filepath.Join(tempDir(t), "config", "panel-credentials.json"))
	var generated atomic.Int32
	var printedMu sync.Mutex
	var printed []string
	const runs = 8
	start := make(chan struct{})
	results := make(chan FirstBootOutcome, runs)
	errors := make(chan error, runs)
	var workers sync.WaitGroup
	for i := 0; i < runs; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			outcome, err := ensureFirstBootCredentials(store, firstBootOptions{
				hasher: NewScryptHasher(),
				generatePassword: func() string {
					return fmt.Sprintf("Password-%02d", generated.Add(1))
				},
				print: func(line string) {
					printedMu.Lock()
					printed = append(printed, line)
					printedMu.Unlock()
				},
			})
			results <- outcome
			errors <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	close(errors)
	created := 0
	for outcome := range results {
		if outcome == FirstBootCreated {
			created++
		} else if outcome != FirstBootAlreadyPresent {
			t.Errorf("并发首启 outcome = %v，期望 Created 或 AlreadyPresent", outcome)
		}
	}
	for err := range errors {
		if err != nil {
			t.Errorf("并发首启失败：%v", err)
		}
	}
	if created != 1 || generated.Load() != 1 {
		t.Fatalf("created=%d, generated=%d；期望只生成一次", created, generated.Load())
	}
	passwordLines := 0
	for _, line := range printed {
		if strings.HasPrefix(line, "初始密码：") {
			passwordLines++
		}
	}
	if passwordLines != 1 {
		t.Fatalf("横幅初始密码行数 = %d，期望 1", passwordLines)
	}
}

func TestEnsureFirstBootDoesNotReplaceInvalidExistingFile(t *testing.T) {
	path := filepath.Join(tempDir(t), "config", "panel-credentials.json")
	writePrivate(t, path, "invalid credentials")
	store := NewFileCredentialsStore(path)
	var printed []string
	if _, err := ensureFirstBootCredentials(store, firstBootOptions{print: func(line string) { printed = append(printed, line) }}); err == nil {
		t.Fatal("已有无效凭据时应拒绝自动生成替代密码")
	}
	contents, err := os.ReadFile(path)
	if err != nil || string(contents) != "invalid credentials" {
		t.Fatalf("无效凭据被覆盖：contents=%q err=%v", contents, err)
	}
	if len(printed) != 0 {
		t.Fatalf("无效凭据时不应打印初始密码：%v", printed)
	}
}

func TestEnsureFirstBootCreated(t *testing.T) {
	dir := tempDir(t)
	store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
	var printed []string
	outcome, err := ensureFirstBootCredentials(store, firstBootOptions{dev: false, print: func(line string) { printed = append(printed, line) }})
	if err != nil {
		t.Fatalf("ensureFirstBootCredentials 失败：%v", err)
	}
	if outcome != FirstBootCreated {
		t.Errorf("outcome = %v，期望 FirstBootCreated", outcome)
	}
	banner := printed
	joined := ""
	for _, line := range banner {
		joined += line + "\n"
	}
	if !strings.Contains(joined, "用户名：admin") {
		t.Errorf("横幅缺用户名行：%v", banner)
	}
	// 改密指引与安装摘要同口径：ely 菜单为主入口，脚本通道带生产 HOME。
	if !strings.Contains(joined, "修改密码：sudo ely 后选择「重置密码」（脚本通道：HOME=/var/lib/elysian elysian resetpwd）") {
		t.Errorf("横幅改密指引不符：%v", banner)
	}
	password := ""
	for _, line := range banner {
		if len(line) > len("初始密码：") && line[:len("初始密码：")] == "初始密码：" {
			password = line[len("初始密码："):]
		}
	}
	if !regexp.MustCompile(`^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{16}$`).MatchString(password) {
		t.Errorf("初始密码形状不符：%q", password)
	}
	current, err := store.Current()
	if err != nil || current == nil {
		t.Fatalf("首启后凭据应落盘：Current() = (%v, %v)", current, err)
	}
	ok, err := NewScryptHasher().Verify(password, current.PasswordHash)
	if err != nil || !ok {
		t.Errorf("初始密码可 verify = (%v, %v)，期望 (true, nil)", ok, err)
	}
}

func TestEnsureFirstBootTwoRunsDiffer(t *testing.T) {
	passwords := make([]string, 0, 2)
	for i := 0; i < 2; i++ {
		dir := tempDir(t)
		store := NewFileCredentialsStore(filepath.Join(dir, "config", "panel-credentials.json"))
		var printed []string
		if _, err := ensureFirstBootCredentials(store, firstBootOptions{dev: false, print: func(line string) { printed = append(printed, line) }}); err != nil {
			t.Fatalf("第 %d 次首启失败：%v", i+1, err)
		}
		for _, line := range printed {
			if len(line) > len("初始密码：") && line[:len("初始密码：")] == "初始密码：" {
				passwords = append(passwords, line[len("初始密码："):])
			}
		}
	}
	if passwords[0] == passwords[1] {
		t.Errorf("两次首启生成相同密码：%q", passwords[0])
	}
}
