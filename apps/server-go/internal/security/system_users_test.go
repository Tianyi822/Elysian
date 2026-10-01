package security

// 系统账号纯推导的对等测试（对齐 parseSystemUsers.test.ts，security 盘点 §8）。

import (
	"strings"
	"testing"
)

func strp(v string) *string { return &v }
func intp(v int) *int       { return &v }

func TestParseShadowLine(t *testing.T) {
	cases := []struct {
		line       string
		wantNil    bool
		hash       string
		expireDays *int
	}{
		{"elysian:$6$hash:20000:0:99999:7:::", false, "$6$hash", nil},
		{"elysian:!:20000:0:99999:7:::", false, "!", nil},
		{"elysian:*:20000:0:99999:7:::", false, "*", nil},
		{"elysian:!$6$hash:20000:0:99999:7:::", false, "!$6$hash", nil},
		// 9 字段形态：expire 为第 8 字段。
		{"elysian:$6$hash:20000:0:99999:7::1:", false, "$6$hash", intp(1)},
		{"elysian:$6$hash:20000:0:99999:7::-1:", false, "$6$hash", nil},
		// 字段不足跳过。
		{"elysian:$6$hash:", true, "", nil},
		{":$6$hash:20000:0:99999:7:::", true, "", nil},
	}
	for _, c := range cases {
		got := ParseShadowLine(c.line)
		if c.wantNil {
			if got != nil {
				t.Errorf("ParseShadowLine(%q) 应为 nil", c.line)
			}
			continue
		}
		if got == nil {
			t.Errorf("ParseShadowLine(%q) 不应为 nil", c.line)
			continue
		}
		if got.PasswordHash != c.hash {
			t.Errorf("ParseShadowLine(%q).hash = %q，want %q", c.line, got.PasswordHash, c.hash)
		}
		if (got.ExpireDays == nil) != (c.expireDays == nil) {
			t.Errorf("ParseShadowLine(%q).expire = %v，want %v", c.line, got.ExpireDays, c.expireDays)
		} else if c.expireDays != nil && *got.ExpireDays != *c.expireDays {
			t.Errorf("ParseShadowLine(%q).expire = %d，want %d", c.line, *got.ExpireDays, *c.expireDays)
		}
	}
	if ParseGetentShadow("") != nil && len(ParseGetentShadow("")) != 0 {
		t.Errorf("空串输出应为空数组")
	}
}

func TestParseGroupMembers(t *testing.T) {
	members := ParseGroupMembers("sudo:x:27:ubuntu,elysian\nother:x:1:\nbad\n")
	if !members["ubuntu"] || !members["elysian"] || len(members) != 2 {
		t.Errorf("成员切分失败：%v", members)
	}
	members = ParseGroupMembers("sudo:x:27: spaced , user \n")
	if !members["spaced"] || !members["user"] {
		t.Errorf("成员应 trim：%v", members)
	}
}

func TestIsManagedUid边界(t *testing.T) {
	cases := []struct {
		uid  int
		want bool
	}{
		{999, false},
		{1000, true},
		{60000, true},
		{60001, false},
		{65534, false},
		{0, false},
	}
	for _, c := range cases {
		if got := IsManagedUid(c.uid); got != c.want {
			t.Errorf("IsManagedUid(%d) = %v，want %v", c.uid, got, c.want)
		}
	}
}

func TestPasswordUsable(t *testing.T) {
	cases := []struct {
		hash string
		want bool
	}{
		{"", false},
		{"!", false},
		{"*", false},
		{"!$6$abc", false},
		{"$6$abc", true},
	}
	for _, c := range cases {
		if got := PasswordUsable(c.hash); got != c.want {
			t.Errorf("PasswordUsable(%q) = %v，want %v", c.hash, got, c.want)
		}
	}
}

func TestIsNoLoginShell(t *testing.T) {
	for _, shell := range []string{"/sbin/nologin", "/usr/sbin/nologin", "/bin/false"} {
		if !IsNoLoginShell(shell) {
			t.Errorf("IsNoLoginShell(%q) 应为 true", shell)
		}
	}
	for _, shell := range []string{"/bin/bash", "/bin/sh", "/bin/zsh"} {
		if IsNoLoginShell(shell) {
			t.Errorf("IsNoLoginShell(%q) 应为 false", shell)
		}
	}
}

func TestKeyUsable(t *testing.T) {
	cases := []struct {
		text *string
		want bool
	}{
		{nil, false},
		{strp(""), false},
		{strp("   \n # 注释 \n"), false},
		{strp("# 注释\nssh-ed25519 AAAA c\n"), true},
	}
	for _, c := range cases {
		if got := KeyUsable(c.text); got != c.want {
			t.Errorf("KeyUsable(%v) = %v，want %v", c.text, got, c.want)
		}
	}
}

func TestLoginMethodOf四档(t *testing.T) {
	hash := "$6$abc"
	keys := "ssh-ed25519 AAAA c\n"
	cases := []struct {
		shell string
		hash  *string
		keys  *string
		want  string
	}{
		{"/sbin/nologin", &hash, &keys, "none"}, // nologin 优先，双有也 none
		{"/bin/bash", &hash, &keys, "password-or-key"},
		{"/bin/bash", &hash, nil, "password"},
		{"/bin/bash", nil, &keys, "key"},
		{"/bin/bash", nil, nil, "none"},        // 双无如实 none
		{"/bin/bash", strp("!"), &keys, "key"}, // 锁定哈希按无密码
	}
	for _, c := range cases {
		if got := LoginMethodOf(c.shell, c.hash, c.keys); got != c.want {
			t.Errorf("LoginMethodOf(%q, %v, %v) = %q，want %q", c.shell, c.hash, c.keys != nil, got, c.want)
		}
	}
}

func TestDaysSinceEpochUtc与StatusOf边界(t *testing.T) {
	// 2026-09-20 是 epoch 第 20686 天（本地时区无关：字段是 UTC 天）。
	now := "2026-09-20T00:00:00.000Z"
	today := daysSinceEpochUtc(now)
	yesterday := today - 1
	tomorrow := today + 1
	if StatusOf(intp(today), now) != "disabled" {
		t.Errorf("过期日等于今天应 disabled")
	}
	if StatusOf(intp(yesterday), now) != "disabled" {
		t.Errorf("过期日早于今天应 disabled")
	}
	if StatusOf(intp(tomorrow), now) != "active" {
		t.Errorf("过期日晚于今天应 active")
	}
	if StatusOf(nil, now) != "active" {
		t.Errorf("未设置过期应 active")
	}
	// usermod -e 1（1970-01-02）永远处于已过期。
	if StatusOf(intp(1), now) != "disabled" {
		t.Errorf("expire=1 应永远 disabled")
	}
}

func TestNoteOfGecos(t *testing.T) {
	if got := NoteOfGecos("  值班账号  "); got == nil || *got != "值班账号" {
		t.Errorf("GECOS trim 失败：%v", got)
	}
	if got := NoteOfGecos(""); got != nil {
		t.Errorf("空 GECOS 应为 nil：%v", got)
	}
	if got := NoteOfGecos("   "); got != nil {
		t.Errorf("纯空白 GECOS 应为 nil：%v", got)
	}
}

func TestDeriveHostUser整形(t *testing.T) {
	user := DeriveHostUser(HostUserDeriveState{
		Passwd:             PasswdRecord{Name: "elysian", UID: 1000, GID: 1000, Gecos: " 值班账号 ", Home: "/home/elysian", Shell: "/bin/bash"},
		Shadow:             &ShadowRecord{Name: "elysian", PasswordHash: "$6$h"},
		SudoMembers:        map[string]bool{"elysian": true},
		AuthorizedKeysText: nil,
		NowIso:             "2026-09-20T00:00:00.000Z",
	})
	if user.ID != "elysian" || user.Name != "elysian" {
		t.Errorf("id=name 应为用户名：%+v", user)
	}
	if !user.IsAdmin {
		t.Errorf("sudo 成员应为管理员")
	}
	if user.LoginMethod != "password" {
		t.Errorf("登录方式应如实推导：%q", user.LoginMethod)
	}
	if user.Status != "active" {
		t.Errorf("未过期应 active")
	}
	if user.Note == nil || *user.Note != "值班账号" {
		t.Errorf("备注取 GECOS trim：%v", user.Note)
	}
	if user.CreatedAt != nil {
		t.Errorf("createdAt 恒为 null")
	}
	// 过期推导 disabled 且登录方式仍如实推导。
	expired := DeriveHostUser(HostUserDeriveState{
		Passwd:             PasswdRecord{Name: "ops", UID: 1001, GID: 1001, Gecos: "", Home: "/home/ops", Shell: "/bin/bash"},
		Shadow:             &ShadowRecord{Name: "ops", PasswordHash: "!", ExpireDays: intp(1)},
		SudoMembers:        map[string]bool{},
		AuthorizedKeysText: strp("ssh-ed25519 AAAA c\n"),
		NowIso:             "2026-09-20T00:00:00.000Z",
	})
	if expired.Status != "disabled" || expired.LoginMethod != "key" {
		t.Errorf("过期账号状态与登录方式应各自如实：%+v", expired)
	}
}

func TestParseGetentPasswdRecords(t *testing.T) {
	output := strings.Join([]string{
		"root:x:0:0:root:/root:/bin/bash",
		"short:x:1",
		"nonnum:x:a:b::/h:/bin/sh",
		"elysian:x:1000:1000:值班:/home/elysian:/bin/bash",
	}, "\n")
	records := ParseGetentPasswdRecords(output)
	if len(records) != 2 {
		t.Fatalf("应跳过坏行，得 %d", len(records))
	}
	if records[1].Gecos != "值班" {
		t.Errorf("GECOS 字段解析错：%q", records[1].Gecos)
	}
}
