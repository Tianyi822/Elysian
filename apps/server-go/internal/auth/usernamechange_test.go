package auth

import (
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestUsernameChangeLoginAndSessionInvalidation(t *testing.T) {
	connections := &spyConnections{}
	audit := NewMemoryPasswordAudit()
	client, credentials := newWiringFixture(t, func(deps *Deps) { deps.SessionConns = connections; deps.PasswordAudit = audit })
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	web := cookiePair(login.Header().Get("Set-Cookie"))
	cliLogin := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password","client":"cli"}`, "")
	cli := cookiePair(cliLogin.Header().Get("Set-Cookie"))
	before, _ := credentials.Current()
	changed := client.postJSON("/api/auth/username", `{"newUsername":"Ops_User-42","currentPassword":"e2e-password"}`, web)
	if changed.Code != http.StatusOK {
		t.Fatalf("改名失败：%d %s", changed.Code, changed.Body.String())
	}
	if changed.Header().Get("Set-Cookie") != sessionCookie("", 0, false) {
		t.Fatal("改名未清 Cookie")
	}
	after, _ := credentials.Current()
	if after.Username != "Ops_User-42" || after.PasswordHash != before.PasswordHash || after.PasswordChangedAt == before.PasswordChangedAt {
		t.Fatalf("错误凭据：%+v", after)
	}
	if connections.revokeAlls != 1 {
		t.Fatal("未撤销会话连接")
	}
	for _, cookie := range []string{web, cli} {
		if result := client.get("/api/containers", cookie); result.Code != http.StatusUnauthorized {
			t.Fatalf("旧会话仍有效：%d", result.Code)
		}
	}
	if result := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, ""); result.Code != http.StatusUnauthorized {
		t.Fatal("旧用户名仍可登录")
	}
	newLogin := client.postJSON("/api/auth/login", `{"username":"Ops_User-42","password":"e2e-password"}`, "")
	if newLogin.Code != http.StatusOK {
		t.Fatalf("新用户名无法登录：%s", newLogin.Body.String())
	}
	newCookie := cookiePair(newLogin.Header().Get("Set-Cookie"))
	status := decodeJSON(t, client.get("/api/auth/session", newCookie))
	if status["username"] != "Ops_User-42" {
		t.Fatalf("会话身份错误：%v", status)
	}
	result := client.postJSON("/api/auth/password", `{"currentPassword":"e2e-password","newPassword":"new-password-42","confirmNewPassword":"new-password-42"}`, newCookie)
	if result.Code != http.StatusOK {
		t.Fatalf("改名后改密失败：%s", result.Body.String())
	}
	current, _ := credentials.Current()
	if current.Username != "Ops_User-42" {
		t.Fatal("改密覆盖用户名")
	}
	if records := audit.Records(); len(records) != 1 || records[0].Actor != "Ops_User-42" {
		t.Fatalf("改密审计身份错误：%+v", records)
	}
	if result := client.get("/api/containers", newCookie); result.Code != http.StatusUnauthorized {
		t.Fatal("改密未失效当前会话")
	}
}

func TestUsernameChangeRejectionsPreserveCredentials(t *testing.T) {
	for _, test := range []struct{ name, username, password, message string }{
		{"short", "ab", "e2e-password", "用户名须为 3–32 位英文字母、数字、下划线或短横线"},
		{"long", strings.Repeat("a", 33), "e2e-password", "用户名须为 3–32 位英文字母、数字、下划线或短横线"},
		{"unicode", "运维人员", "e2e-password", "用户名须为 3–32 位英文字母、数字、下划线或短横线"},
		{"whitespace", "ops user", "e2e-password", "用户名须为 3–32 位英文字母、数字、下划线或短横线"},
		{"same", "admin", "e2e-password", "新用户名不能与当前用户名相同"},
		{"reserved", "dev", "e2e-password", "不能使用开发保留用户名 dev"},
		{"password", "ops-user", "wrong-password", "当前密码不正确"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, credentials := newWiringFixture(t, nil)
			login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
			cookie := cookiePair(login.Header().Get("Set-Cookie"))
			before, _ := credentials.Current()
			result := client.postJSON("/api/auth/username", fmt.Sprintf(`{"newUsername":%q,"currentPassword":%q}`, test.username, test.password), cookie)
			wantStatusBody(t, result, http.StatusBadRequest, test.message)
			after, _ := credentials.Current()
			if *before != *after || result.Header().Get("Set-Cookie") != "" {
				t.Fatal("失败修改了凭据或 Cookie")
			}
			if status := decodeJSON(t, client.get("/api/auth/session", cookie)); status["authenticated"] != true {
				t.Fatal("失败使会话失效")
			}
		})
	}
}

func TestUsernameEndpointRequiresSessionAndSameOrigin(t *testing.T) {
	client, _ := newWiringFixture(t, nil)
	body := `{"newUsername":"operator","currentPassword":"e2e-password"}`
	if result := client.postJSON("/api/auth/username", body, ""); result.Code != http.StatusUnauthorized {
		t.Fatal("未登录可改名")
	}
	login := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
	cookie := cookiePair(login.Header().Get("Set-Cookie"))
	if result := client.do(http.MethodPost, "/api/auth/username", cookie, "https://other.example", body); result.Code != http.StatusForbidden {
		t.Fatal("跨源可改名")
	}
}

func TestCredentialsConcurrentRenameRejectsStaleVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	first := NewFileCredentialsStore(path)
	before, err := first.Write("hash:original")
	if err != nil {
		t.Fatal(err)
	}
	second := NewFileCredentialsStore(path)
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for index, store := range []CredentialsStore{first, second} {
		wg.Add(1)
		go func(index int, store CredentialsStore) {
			defer wg.Done()
			_, err := store.Update(before, fmt.Sprintf("ops-%d", index), before.PasswordHash)
			errors <- err
		}(index, store)
	}
	wg.Wait()
	close(errors)
	success, rejected := 0, 0
	for err := range errors {
		if err == nil {
			success++
		} else if err.Error() == "账号凭据已发生变化，请重新登录后再试" {
			rejected++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || rejected != 1 {
		t.Fatalf("并发更新：成功 %d，拒绝 %d", success, rejected)
	}
	restarted := NewFileCredentialsStore(path)
	current, err := restarted.Current()
	if err != nil || current == nil || current.Username == "admin" || current.PasswordHash != before.PasswordHash {
		t.Fatal("重启未恢复改名")
	}
	reset, err := ChangePanelPassword(restarted, NewScryptHasher(), "reset-password-42", "reset-password-42")
	if err != nil || reset.Username != current.Username || reset.PasswordChangedAt == current.PasswordChangedAt {
		t.Fatal("CLI 改密未保留用户名或更新 epoch")
	}
}

func TestUsernameChangeWriteFailure(t *testing.T) {
	store := &ioErrorCredentials{inner: NewMemoryCredentialsStore(&PanelCredentials{Username: "admin", PasswordHash: mustHash(t, "current-password"), PasswordChangedAt: testEpoch})}
	f := newRoutesFixture(t, func(deps *Deps) { deps.Credentials = store })
	result := f.request(http.MethodPost, "/username", `{"newUsername":"operator","currentPassword":"current-password"}`, map[string]string{"Origin": testOrigin, "Host": "localhost:5173"})
	if result.Code != http.StatusInternalServerError || result.Header().Get("Set-Cookie") != "" {
		t.Fatalf("写失败收尾错误：%d", result.Code)
	}
	current, _ := store.Current()
	if current.Username != "admin" {
		t.Fatal("失败覆盖了用户名")
	}
}

func TestDevSessionReportsActualLoginName(t *testing.T) {
	f := newRoutesFixture(t, func(deps *Deps) { deps.DevAccount = true })
	login := f.login(`{"username":"dev","password":"dev-elysian"}`)
	status := decodeJSON(t, f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": cookiePair(login.Header().Get("Set-Cookie"))}))
	if status["username"] != "dev" {
		t.Fatalf("开发身份错误：%v", status)
	}
}

func TestLegacySessionUsernameCompatibility(t *testing.T) {
	for _, dev := range []bool{false, true} {
		f := newRoutesFixture(t, func(deps *Deps) { deps.DevAccount = dev })
		epoch, name := "none", "dev"
		if !dev {
			credentials, err := f.credentials.Update(nil, "custom-admin", "hash:existing")
			if err != nil {
				t.Fatal(err)
			}
			epoch, name = credentials.PasswordChangedAt, credentials.Username
		}
		legacy, _, err := f.sessions.Create(epoch, SessionClientWeb)
		if err != nil {
			t.Fatal(err)
		}
		status := decodeJSON(t, f.request(http.MethodGet, "/session", "", map[string]string{"Cookie": "elysian_session=" + legacy.ID}))
		if status["username"] != name {
			t.Fatalf("旧会话身份：%v", status)
		}
	}
}

func TestCLIResetPreservesRenamedUsername(t *testing.T) {
	store := NewMemoryCredentialsStore(&PanelCredentials{Username: "custom-admin", PasswordHash: "old-hash", PasswordChangedAt: testEpoch})
	io := makeScriptedIO(false)
	io.reset("reset-password-42", "reset-password-42")
	if err := runResetPasswordCli(io.asResetPasswordIO(), store, NewScryptHasher(), false); err != nil {
		t.Fatal(err)
	}
	current, _ := store.Current()
	if current.Username != "custom-admin" || !strings.Contains(strings.Join(io.printed, "\n"), "管理员：custom-admin") {
		t.Fatal("CLI 未保留或显示自定义用户名")
	}
}
