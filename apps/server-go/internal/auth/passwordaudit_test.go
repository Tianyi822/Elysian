package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// 改密安全审计测试：HTTP 与 CLI 两条线各锚定成功/失败一条记录、记录不含密码内容、
// CLI 按注入 panelHome 落对位置、审计写盘失败不破坏改密主结果，以及文件版保留整理
//（按龄过期与体积上限）与字段单行化净化。

// auditISOAt 校验 at 是毫秒精度 ISO 串。
func auditISOAt(t *testing.T, at string) {
	t.Helper()
	if _, err := time.Parse(isoMillisLayout, at); err != nil {
		t.Errorf("at 不是毫秒精度 ISO 串：%q（%v）", at, err)
	}
}

func TestPasswordChangeHTTPSuccessAudited(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	cookie := f.loginCookie2(t, "current-password")
	recorder := f.changePassword(
		`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		map[string]string{"Cookie": cookie})
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	records := f.passwordAudit.Records()
	if len(records) != 1 {
		t.Fatalf("成功改密应恰好落一条审计，得 %d 条：%+v", len(records), records)
	}
	record := records[0]
	if record.Source != PasswordAuditSourcePanelHTTP {
		t.Errorf("source = %q，期望 panel-http", record.Source)
	}
	if record.Actor != PanelUsername {
		t.Errorf("actor = %q，期望单用户管理员 %q", record.Actor, PanelUsername)
	}
	if record.Result != passwordAuditResultSuccess {
		t.Errorf("result = %q，期望 success", record.Result)
	}
	if record.Reason != "" {
		t.Errorf("成功记录不应携带原因：%q", record.Reason)
	}
	auditISOAt(t, record.At)
	if credentials.writes != 1 {
		t.Errorf("主流程应恰好一次 write（得 %d），审计不得改变主结果", credentials.writes)
	}
}

func TestPasswordChangeHTTPFailureAuditedSanitized(t *testing.T) {
	f, credentials := newSettingsFixture(t, nil)
	recorder := f.changePassword(
		`{"currentPassword":"wrong-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		nil)
	wantStatusBody(t, recorder, http.StatusBadRequest, "当前密码不正确")
	records := f.passwordAudit.Records()
	if len(records) != 1 {
		t.Fatalf("失败改密应恰好落一条审计，得 %d 条：%+v", len(records), records)
	}
	record := records[0]
	if record.Source != PasswordAuditSourcePanelHTTP || record.Actor != PanelUsername {
		t.Errorf("source/actor = %q/%q", record.Source, record.Actor)
	}
	if record.Result != passwordAuditResultFailure {
		t.Errorf("result = %q，期望 failure", record.Result)
	}
	if record.Reason != "当前密码不正确" {
		t.Errorf("reason = %q，期望固定中文原因", record.Reason)
	}
	auditISOAt(t, record.At)
	if credentials.writes != 0 {
		t.Errorf("失败不应改写凭据（writes=%d）", credentials.writes)
	}
	// 记录全文不得含任何密码或哈希内容。
	encoded, err := shared.MarshalJSON(record)
	if err != nil {
		t.Fatalf("序列化审计记录失败：%v", err)
	}
	for _, secret := range []string{"wrong-password", "brand-new-password", "current-password", "scrypt", "passwordHash"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("审计记录包含敏感内容 %q：%s", secret, encoded)
		}
	}
}

func TestPasswordChangeDisabledDemoNotAudited(t *testing.T) {
	f, _ := newSettingsFixture(t, func(deps *Deps) { deps.Enabled = false })
	recorder := f.changePassword(
		`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("演示语义应 503，得 %d", recorder.Code)
	}
	if records := f.passwordAudit.Records(); len(records) != 0 {
		t.Errorf("演示 503 分支不解析任何改密尝试，不应落审计：%+v", records)
	}
}

func TestPasswordChangeAuditWriteFailureKeepsResponse(t *testing.T) {
	dir := tempDir(t)
	auditPath := filepath.Join(dir, "logs", "panel-password-audit.jsonl")
	// 同名目录堵死审计文件：追加打开必然失败，审计只能降级诊断。
	if err := os.MkdirAll(auditPath, 0o700); err != nil {
		t.Fatalf("建同名目录失败：%v", err)
	}
	f, credentials := newSettingsFixture(t, func(deps *Deps) { deps.PasswordAudit = NewFilePasswordAudit(auditPath) })
	cookie := f.loginCookie2(t, "current-password")
	recorder := f.changePassword(
		`{"currentPassword":"current-password","newPassword":"brand-new-password","confirmNewPassword":"brand-new-password"}`,
		map[string]string{"Cookie": cookie})
	if recorder.Code != http.StatusOK {
		t.Fatalf("审计写盘失败不得改变主结果，状态码 = %d（%s）", recorder.Code, recorder.Body.String())
	}
	if body := decodeJSON(t, recorder); body["ok"] != true {
		t.Errorf("响应体 = %v", body)
	}
	if credentials.writes != 1 {
		t.Errorf("改密主流程不受审计失败影响（writes=%d）", credentials.writes)
	}
}

func TestResetPasswordCLIAtAuditsSuccessUnderPanelHome(t *testing.T) {
	dir := tempDir(t)
	stdin := strings.NewReader("audit-cli-pwd-1\naudit-cli-pwd-1\n")
	stdout := &bytes.Buffer{}
	if code := RunResetPasswordCLIAt(dir, stdin, stdout); code != 0 {
		t.Fatalf("退出码 = %d，输出 %q", code, stdout.String())
	}
	auditPath := filepath.Join(dir, "logs", "panel-password-audit.jsonl")
	data, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatalf("审计应落在注入 panelHome 的 logs/ 下：%v", err)
	}
	content := string(data)
	if strings.Contains(content, "audit-cli-pwd-1") {
		t.Errorf("审计文件不得包含密码明文：%q", content)
	}
	var lines []string
	for _, line := range strings.Split(content, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) != 1 {
		t.Fatalf("成功改密应恰好一行审计，得 %d 行：%q", len(lines), content)
	}
	var record PasswordAuditRecord
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatalf("审计行不是合法 JSON：%v（%q）", err, lines[0])
	}
	if record.Source != PasswordAuditSourceCLIResetPwd {
		t.Errorf("source = %q，期望 cli-resetpwd", record.Source)
	}
	if record.Result != passwordAuditResultSuccess || record.Reason != "" {
		t.Errorf("result/reason = %q/%q", record.Result, record.Reason)
	}
	if !regexp.MustCompile(`^(.+\(\d+\)|uid=\d+)$`).MatchString(record.Actor) {
		t.Errorf("actor 应为 <用户名>(<uid>) 或 uid=<uid>：%q", record.Actor)
	}
	auditISOAt(t, record.At)
	fi, err := os.Stat(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("审计文件权限 = %o，期望 0600", fi.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(auditPath))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("审计目录权限 = %o，期望 0700", dirInfo.Mode().Perm())
	}
}

func TestResetPasswordCLIAtAuditsFailureUnderPanelHome(t *testing.T) {
	dir := tempDir(t)
	stdin := strings.NewReader("audit-cli-pwd-1\ndifferent-pwd\n")
	if code := RunResetPasswordCLIAt(dir, stdin, &bytes.Buffer{}); code != 1 {
		t.Fatalf("两次不一致应回 1，得 %d", code)
	}
	data, err := os.ReadFile(filepath.Join(dir, "logs", "panel-password-audit.jsonl"))
	if err != nil {
		t.Fatalf("失败也应落审计：%v", err)
	}
	content := string(data)
	for _, secret := range []string{"audit-cli-pwd-1", "different-pwd"} {
		if strings.Contains(content, secret) {
			t.Errorf("审计文件不得包含密码明文 %q：%q", secret, content)
		}
	}
	var record PasswordAuditRecord
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &record); err != nil {
		t.Fatalf("审计行不是合法 JSON：%v（%q）", err, content)
	}
	if record.Source != PasswordAuditSourceCLIResetPwd || record.Result != passwordAuditResultFailure {
		t.Errorf("source/result = %q/%q", record.Source, record.Result)
	}
	if record.Reason != "两次输入的密码不一致" {
		t.Errorf("reason = %q，期望固定中文原因", record.Reason)
	}
	if _, err := os.Stat(filepath.Join(dir, "config", "panel-credentials.json")); !os.IsNotExist(err) {
		t.Error("失败不应写凭据文件")
	}
}

func TestNewFilePasswordAuditDefaultPath(t *testing.T) {
	sink, ok := NewFilePasswordAudit("").(*filePasswordAudit)
	if !ok {
		t.Fatal("缺省构造应产出文件版审计")
	}
	if sink.path != paths.Default.PanelPasswordAudit {
		t.Errorf("缺省路径 = %q，期望 paths.Default.PanelPasswordAudit = %q", sink.path, paths.Default.PanelPasswordAudit)
	}
}

func TestFilePasswordAuditPruneDropsExpiredByAge(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "logs", "panel-password-audit.jsonl")
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	audit := &filePasswordAudit{
		path: path, now: func() time.Time { return now },
		retention: passwordAuditRetention, maxBytes: passwordAuditMaxBytes,
	}
	expired := buildPasswordAuditRecord(
		now.Add(-31*24*time.Hour).Format(isoMillisLayout), PasswordAuditSourceCLIResetPwd,
		"root(0)", passwordAuditResultSuccess, "")
	fresh := buildPasswordAuditRecord(
		now.Add(-time.Hour).Format(isoMillisLayout), PasswordAuditSourcePanelHTTP,
		"admin", passwordAuditResultFailure, "当前密码不正确")
	seed := strings.Join([]string{mustAuditJSON(t, expired), mustAuditJSON(t, fresh)}, "\n") + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	audit.RecordPasswordChange(buildPasswordAuditRecord(
		now.Format(isoMillisLayout), PasswordAuditSourceCLIResetPwd, "root(0)", passwordAuditResultSuccess, ""))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if strings.Contains(content, expired.At) {
		t.Errorf("超过 30 天保留窗口的记录应被整理删除：%q", content)
	}
	if !strings.Contains(content, fresh.At) {
		t.Errorf("保留窗口内的记录不应被删除：%q", content)
	}
	if got := strings.Count(content, "\n"); got != 2 {
		t.Errorf("整理后应恰好两行（fresh+新记录），得 %d 行：%q", got, content)
	}
}

func TestFilePasswordAuditPruneDropsOldestBeyondSizeCap(t *testing.T) {
	dir := tempDir(t)
	path := filepath.Join(dir, "logs", "panel-password-audit.jsonl")
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	audit := &filePasswordAudit{
		path: path, now: func() time.Time { return now },
		retention: passwordAuditRetention, maxBytes: 300,
	}
	for i := 0; i < 8; i++ {
		audit.RecordPasswordChange(buildPasswordAuditRecord(
			now.Add(time.Duration(i)*time.Minute).Format(isoMillisLayout),
			PasswordAuditSourceCLIResetPwd, "root(0)", passwordAuditResultFailure,
			"第几条改密失败记录-体积整理用-"+strings.Repeat("占", 20)))
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > 300 {
		t.Errorf("整理后文件不应超体积上限：%d 字节", fi.Size())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, now.Add(7*time.Minute).Format(isoMillisLayout)) {
		t.Errorf("体积整理应保留最新记录：%q", content)
	}
	if strings.Contains(content, now.Format(isoMillisLayout)) {
		t.Errorf("超上限时应从最旧侧删除：%q", content)
	}
}

func TestBuildPasswordAuditRecordSanitizesFields(t *testing.T) {
	record := buildPasswordAuditRecord(
		"2026-10-24T00:00:00.000Z", PasswordAuditSourcePanelHTTP,
		"ad\nmin\t(0)", passwordAuditResultFailure, "当前密码不正确\r\n第二行")
	if strings.ContainsAny(record.Actor, "\n\t\r") {
		t.Errorf("actor 应被单行化：%q", record.Actor)
	}
	if record.Reason != "当前密码不正确 第二行" {
		t.Errorf("reason 应控制字符换空格并去首尾空白：%q", record.Reason)
	}
	truncated := buildPasswordAuditRecord(
		"2026-10-24T00:00:00.000Z", PasswordAuditSourceCLIResetPwd,
		"root(0)", passwordAuditResultFailure, strings.Repeat("密", 300))
	if got := utf16Length(truncated.Reason); got != passwordAuditReasonMaxLength {
		t.Errorf("reason 应按 UTF-16 上限 %d 截断，得 %d", passwordAuditReasonMaxLength, got)
	}
}

func mustAuditJSON(t *testing.T, record PasswordAuditRecord) string {
	t.Helper()
	data, err := shared.MarshalJSON(record)
	if err != nil {
		t.Fatalf("序列化审计记录失败：%v", err)
	}
	return string(data)
}

func TestPasswordAuditSubprocess(t *testing.T) {
	path := os.Getenv("ELYSIAN_AUDIT_TEST_PATH")
	if path == "" {
		return
	}
	sink := NewFilePasswordAudit(path)
	for i := 0; i < 30; i++ {
		sink.RecordPasswordChange(buildPasswordAuditRecord(time.Now().UTC().Format(isoMillisLayout), PasswordAuditSourceCLIResetPwd, fmt.Sprintf("%s-%d", os.Getenv("ELYSIAN_AUDIT_TEST_ID"), i), passwordAuditResultSuccess, ""))
	}
	os.Exit(0)
}
func TestPasswordAuditConcurrentProcessesPreserveRecordsWhilePruning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	seed := PasswordAuditRecord{At: "2000-01-01T00:00:00.000Z", Source: PasswordAuditSourceCLIResetPwd, Actor: "expired", Result: passwordAuditResultSuccess}
	raw, _ := json.Marshal(seed)
	_ = os.WriteFile(path, append(raw, '\n'), 0600)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			cmd := exec.Command(os.Args[0], "-test.run=^TestPasswordAuditSubprocess$")
			cmd.Env = append(os.Environ(), "ELYSIAN_AUDIT_TEST_PATH="+path, fmt.Sprintf("ELYSIAN_AUDIT_TEST_ID=%d", i))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Errorf("子进程失败：%v %s", err, out)
			}
		}(i)
	}
	wg.Wait()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var r PasswordAuditRecord
		if err = json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		seen[r.Actor] = true
	}
	if len(seen) != 120 || seen["expired"] {
		t.Fatalf("并发追加/裁剪丢失记录：%d", len(seen))
	}
}
