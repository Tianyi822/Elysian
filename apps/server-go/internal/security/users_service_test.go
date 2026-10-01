package security

// usersService 的对等测试（对齐 usersService.test.ts 的关键锚定行为，security
// 盘点 §8）：列表过滤排序、创建/修改/删除的命令序列与回读、保护边界、sudo 防呆、
// 密码与备注判据。全部经 fake deps（内存账号库与命令账本）驱动。

import (
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/shared"
)

func newTestUsersService() (*usersService, *fakeUsersDeps, *memFS) {
	deps, fake := newFakeUsersDeps()
	return newUsersService(deps), fake, fake.fs
}

func noteOf(text string) *string { return &text }

func passOf(text string) *string { return &text }

func mustUserNoError(t *testing.T, name string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s 失败：%v", name, err)
	}
}

func mustUserErrorText(t *testing.T, name string, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s 应失败", name)
	}
	if err.Error() != want {
		t.Errorf("%s 错误文案不符：\n got %q\nwant %q", name, err.Error(), want)
	}
}

// writeCount 数命令账本里非 getent 的写命令条数。
func writeCommandCount(fake *fakeUsersDeps) int {
	count := 0
	for _, c := range fake.commandsSnapshot() {
		if !strings.HasPrefix(c, "getent ") {
			count++
		}
	}
	return count
}

func TestList过滤与排序与如实推导(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	fake.mu.Lock()
	fake.passwd = []string{
		"root:x:0:0:root:/root:/bin/bash",
		"svc:x:999:999::/home/svc:/usr/sbin/nologin",
		"zeta:x:1002:1002::/home/zeta:/bin/bash",
		"elysian:x:1000:1000: 值班账号 :/home/elysian:/bin/bash",
		"alpha:x:1001:1001::/home/alpha:/bin/bash",
		"far:x:60001:60001::/home/far:/bin/bash",
		"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
	}
	fake.shadow = []string{
		"root:$6$r:20000:0:99999:7:::",
		"elysian:$6$e:20000:0:99999:7:::",
		"alpha:*:20000:0:99999:7:::",
		"zeta:!:20000:0:99999:7:::",
	}
	fake.sudoLine = "sudo:x:27:elysian,zeta"
	fake.mu.Unlock()

	users, err := svc.List()
	mustUserNoError(t, "List", err)
	if len(users) != 3 {
		t.Fatalf("只列 uid 1000-60000 的账号（root/svc/far/nobody 排除），得 %d", len(users))
	}
	if users[0].Name != "alpha" || users[1].Name != "elysian" || users[2].Name != "zeta" {
		t.Errorf("应按名字升序：%v", []string{users[0].Name, users[1].Name, users[2].Name})
	}
	// 如实推导：alpha 无可用密码无密钥 → none；elysian 密码可用 → password；zeta 锁定但 sudo。
	if users[0].LoginMethod != "none" {
		t.Errorf("alpha 登录方式应如实 none：%q", users[0].LoginMethod)
	}
	if users[1].LoginMethod != "password" || !users[1].IsAdmin {
		t.Errorf("elysian 应 password 且管理员：%+v", users[1])
	}
	if users[1].Note == nil || *users[1].Note != "值班账号" {
		t.Errorf("备注取 GECOS trim：%v", users[1].Note)
	}
	if users[2].LoginMethod != "none" || !users[2].IsAdmin {
		t.Errorf("zeta 锁定哈希 → none，且是 sudo 成员：%+v", users[2])
	}
	for _, u := range users {
		if u.CreatedAt != nil {
			t.Errorf("createdAt 恒为 null")
		}
	}
}

func TestSyncFromSystem即重读(t *testing.T) {
	svc, _, _ := newTestUsersService()
	total, err := svc.SyncFromSystem()
	mustUserNoError(t, "SyncFromSystem", err)
	users, err := svc.List()
	mustUserNoError(t, "List", err)
	if total != len(users) {
		t.Errorf("sync 总数应与 list 一致：%d vs %d", total, len(users))
	}
}

func TestCreate命令序列与回读(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	input := HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: true, Note: noteOf("值班账号"), Password: passOf("Str0ngPass!1")}
	user, err := svc.Create("newops2", input)
	mustUserNoError(t, "Create", err)

	commands := fake.commandsSnapshot()
	writes := []string{}
	for _, c := range commands {
		if !strings.HasPrefix(c, "getent ") {
			writes = append(writes, c)
		}
	}
	want := []string{
		"useradd -m -s /bin/bash -c 值班账号 newops2",
		"gpasswd -a newops2 sudo",
		"chpasswd",
	}
	if len(writes) != len(want) {
		t.Fatalf("写命令序列不符：%v", writes)
	}
	for i := range want {
		if writes[i] != want[i] {
			t.Errorf("第 %d 条命令不符：got %q want %q", i, writes[i], want[i])
		}
	}
	if len(fake.chpasswdInputs) != 1 || fake.chpasswdInputs[0] != "newops2:Str0ngPass!1" {
		t.Errorf("凭据经 stdin 下发：%v", fake.chpasswdInputs)
	}
	for _, c := range writes {
		if strings.Contains(c, "Str0ngPass") {
			t.Errorf("命令行不得出现密码明文：%q", c)
		}
	}
	// 回读非乐观值：字段来自账号库推导。
	if user.ID != "newops2" || user.Name != "newops2" || !user.IsAdmin {
		t.Errorf("回读字段：%+v", user)
	}
	if user.Note == nil || *user.Note != "值班账号" {
		t.Errorf("备注回读：%v", user.Note)
	}
}

func TestCreate无密码组合(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	// key-only：-p '*'，回读 none（还没有密钥）。
	user, err := svc.Create("keyops", HostUserInput{LoginMethod: "key", Status: "active"})
	mustUserNoError(t, "Create", err)
	if !containsCommand(fake, "useradd -m -s /bin/bash -p * keyops") {
		t.Errorf("无密码创建应带 -p '*'：%v", fake.commandsSnapshot())
	}
	if user.LoginMethod != "none" {
		t.Errorf("回读应如实 none：%q", user.LoginMethod)
	}
	// none + disabled：-p '*' 且 usermod -e 1 -L。
	_, err = svc.Create("disops", HostUserInput{LoginMethod: "none", Status: "disabled"})
	mustUserNoError(t, "Create", err)
	if !containsCommand(fake, "useradd -m -s /sbin/nologin -p * disops") {
		t.Errorf("none 组合应 nologin 且 -p '*'：%v", fake.commandsSnapshot())
	}
	if !containsCommand(fake, "usermod -e 1 -L disops") {
		t.Errorf("disabled 组合应过期加锁：%v", fake.commandsSnapshot())
	}
}

// containsCommand 判断命令账本是否含某条命令。
func containsCommand(fake *fakeUsersDeps, want string) bool {
	for _, c := range fake.commandsSnapshot() {
		if c == want {
			return true
		}
	}
	return false
}

func TestCreate非法与重名零写命令(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	_, err := svc.Create("BadName", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserErrorText(t, "非法用户名", err, "用户名只能用小写字母、数字、下划线与连字符，且由字母或下划线开头")
	_, err = svc.Create("elysian", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserErrorText(t, "重名", err, "用户名已存在：elysian")
	if writeCommandCount(fake) != 0 {
		t.Errorf("拒绝时应零写命令：%v", fake.commandsSnapshot())
	}
}

func TestCreate密码必填与夹带拒绝(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	_, err := svc.Create("pwops", HostUserInput{LoginMethod: "password", Status: "active"})
	mustUserErrorText(t, "密码必填", err, "登录方式含密码时必须填写初始密码")
	_, err = svc.Create("pwops", HostUserInput{LoginMethod: "key", Status: "active", Password: passOf("Str0ngPass!1")})
	mustUserErrorText(t, "夹带密码", err, "登录方式不含密码时不能设置密码")
	_, err = svc.Create("pwops", HostUserInput{LoginMethod: "password", Status: "active", Password: passOf("weak")})
	mustUserErrorText(t, "弱密码", err, "密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号")
	_, err = svc.Create("pwops", HostUserInput{LoginMethod: "password", Status: "active", Password: passOf("带\n换行")})
	mustUserErrorText(t, "换行密码", err, "密码不能包含换行或控制字符")
	if writeCommandCount(fake) != 0 {
		t.Errorf("密码拒绝不应触 chpasswd：%v", fake.commandsSnapshot())
	}
}

func TestCreate备注判据(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	_, err := svc.Create("noteops", HostUserInput{LoginMethod: "none", Status: "active", Note: noteOf("带\n换行")})
	mustUserErrorText(t, "备注换行", err, "备注不能包含换行或控制字符")
	_, err = svc.Create("noteops", HostUserInput{LoginMethod: "none", Status: "active", Note: noteOf("带,逗号")})
	mustUserErrorText(t, "备注逗号", err, "备注不能包含逗号（GECOS 里逗号用于分字段）")
	if writeCommandCount(fake) != 0 {
		t.Errorf("备注拒绝应零写命令：%v", fake.commandsSnapshot())
	}
}

func TestUpdate字段分别落命令(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	// elysian：hash '*'、bash、sudo 成员（仅剩成员时降级被防呆拦，这里保持管理员）。
	_, err := svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: true, Note: noteOf("新备注"), Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "Update", err)
	if !containsCommand(fake, "usermod -c 新备注 elysian") {
		t.Errorf("备注变化应落 usermod -c：%v", fake.commandsSnapshot())
	}
	if containsCommand(fake, "gpasswd -a elysian sudo") || containsCommand(fake, "gpasswd -d elysian sudo") {
		t.Errorf("管理员归属未变不应执行 gpasswd：%v", fake.commandsSnapshot())
	}
	if containsCommand(fake, "usermod -s /bin/bash elysian") {
		t.Errorf("shell 未变不应执行 usermod -s：%v", fake.commandsSnapshot())
	}
}

func TestUpdate切none置星不锁号(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	// newops：可用哈希、bash → 切 none 应 -p '*'（无 -L）。
	_, err := svc.Update("newops", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserNoError(t, "Update", err)
	if !containsCommand(fake, "usermod -p * newops") {
		t.Errorf("切 none 应置 '*'：%v", fake.commandsSnapshot())
	}
	for _, c := range fake.commandsSnapshot() {
		if strings.Contains(c, "-L") {
			t.Errorf("作废旧密码不得用 -L（sshd 会连公钥都拒）：%q", c)
		}
	}
}

func TestUpdate星号切回密码要求新密码(t *testing.T) {
	svc, _, _ := newTestUsersService()
	// elysian：hash '*'（占位）→ 启用密码登录必须提供新密码。
	_, err := svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: true})
	mustUserErrorText(t, "占位哈希恢复", err, "当前未设置可用密码，请填写新密码后再启用密码登录")
	_, err = svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: true, Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "提供新密码后启用", err)
}

func TestUpdate切仅密码删除密钥文件(t *testing.T) {
	svc, _, fs := newTestUsersService()
	fs.writeFile("/home/newops/.ssh/authorized_keys", "ssh-ed25519 AAAA c\n")
	_, err := svc.Update("newops", HostUserInput{LoginMethod: "password", Status: "active"})
	mustUserNoError(t, "Update", err)
	if _, ok := fs.file("/home/newops/.ssh/authorized_keys"); ok {
		t.Errorf("切仅密码应真正移除 authorized_keys")
	}
	// password-or-key 保留；无密钥文件不删。
	fs.writeFile("/home/newops/.ssh/authorized_keys", "ssh-ed25519 AAAA c\n")
	_, err = svc.Update("newops", HostUserInput{LoginMethod: "password-or-key", Status: "active", Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "Update", err)
	if _, ok := fs.file("/home/newops/.ssh/authorized_keys"); !ok {
		t.Errorf("password-or-key 不动密钥文件")
	}
	_, err = svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: true, Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "无密钥文件不删", err)
}

func TestUpdate降级与停用恢复(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	// 第二个 sudo 成员在：降级放行。
	fake.mu.Lock()
	fake.sudoLine = "sudo:x:27:elysian,newops"
	fake.mu.Unlock()
	_, err := svc.Update("newops", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: false, Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "Update", err)
	if !containsCommand(fake, "gpasswd -d newops sudo") {
		t.Errorf("降级应 gpasswd -d：%v", fake.commandsSnapshot())
	}

	// 停用：-e 1 -L；恢复：-e ''。
	_, err = svc.Update("newops", HostUserInput{LoginMethod: "none", Status: "disabled"})
	mustUserNoError(t, "停用", err)
	if !containsCommand(fake, "usermod -e 1 -L newops") {
		t.Errorf("停用命令不符：%v", fake.commandsSnapshot())
	}
	_, err = svc.Update("newops", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserNoError(t, "恢复", err)
	if !containsCommand(fake, "usermod -e  newops") {
		t.Errorf("恢复应清过期日（-e ''）：%v", fake.commandsSnapshot())
	}
}

func TestUpdate保护边界零写命令(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	_, err := svc.Update("root", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserErrorText(t, "root", err, "拒绝操作系统账号：root（仅管理 uid 1000-60000 的账号）")
	_, err = svc.Update("far", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserErrorText(t, "uid 越界", err, "拒绝操作系统账号：far（仅管理 uid 1000-60000 的账号）")
	_, err = svc.Update("missing", HostUserInput{LoginMethod: "none", Status: "active"})
	mustUserErrorText(t, "不存在", err, "未找到系统账号：missing")
	if writeCommandCount(fake) != 0 {
		t.Errorf("保护边界拒绝应零写命令：%v", fake.commandsSnapshot())
	}
}

func TestRemove凭据清理与回读(t *testing.T) {
	svc, fake, fs := newTestUsersService()
	fake.mu.Lock()
	fake.sudoLine = "sudo:x:27:elysian,newops"
	fake.mu.Unlock()
	fs.writeFile("/home/newops/.ssh/authorized_keys", "ssh-ed25519 AAAA c\n")
	fs.writeFile("/home/newops/.ssh/authorized_keys.bak", "ssh-ed25519 AAAA old\n")
	fs.writeFile("/home/newops/.bashrc", "PROMPT=1\n")

	mustUserNoError(t, "Remove", svc.Remove("newops"))
	if !containsCommand(fake, "userdel newops") {
		t.Errorf("userdel 裸用户名（不带 -r）：%v", fake.commandsSnapshot())
	}
	for _, gone := range []string{"/home/newops/.ssh/authorized_keys", "/home/newops/.ssh/authorized_keys.bak"} {
		if _, ok := fs.file(gone); ok {
			t.Errorf("凭据应随账号销毁：%s", gone)
		}
	}
	if _, ok := fs.file("/home/newops/.bashrc"); !ok {
		t.Errorf("主目录数据（.bashrc）应保留")
	}
	err := svc.Remove("newops")
	mustUserErrorText(t, "再删", err, "未找到系统账号：newops")
}

func Test最后一个sudo成员防呆(t *testing.T) {
	svc, fake, _ := newTestUsersService()
	// 初始 sudo 组只有 elysian 一个成员。
	_, err := svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: false, Note: noteOf("无关变更")})
	mustUserErrorText(t, "降级仅剩成员", err,
		"拒绝降级 elysian：它是 sudo 组最后一个成员，操作后容器内将没有任何可提权账号")
	if writeCommandCount(fake) != 0 {
		t.Errorf("防呆拒绝时连无关变更也不执行：%v", fake.commandsSnapshot())
	}
	err = svc.Remove("elysian")
	mustUserErrorText(t, "删除仅剩成员", err,
		"拒绝删除 elysian：它是 sudo 组最后一个成员，操作后容器内将没有任何可提权账号")

	// 有第二成员放行。
	fake.mu.Lock()
	fake.sudoLine = "sudo:x:27:elysian,newops"
	fake.mu.Unlock()
	_, err = svc.Update("elysian", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: false, Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "有第二成员降级", err)

	// 非成员不受防呆；明确请求降级也不产生 gpasswd。
	fake.mu.Lock()
	fake.sudoLine = "sudo:x:27:elysian"
	fake.mu.Unlock()
	commandsBefore := len(fake.commandsSnapshot())
	_, err = svc.Update("newops", HostUserInput{LoginMethod: "password", Status: "active", IsAdmin: false, Password: passOf("NewStr0ng!22")})
	mustUserNoError(t, "非成员降级", err)
	after := fake.commandsSnapshot()
	for _, c := range after[commandsBefore:] {
		if strings.Contains(c, "gpasswd") {
			t.Errorf("非成员降级不应产生 gpasswd：%q", c)
		}
	}
}

func TestUpdate的错误分类(t *testing.T) {
	svc, _, _ := newTestUsersService()
	_, err := svc.Update("root", HostUserInput{LoginMethod: "none", Status: "active"})
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 400 {
		t.Errorf("保护边界应 400：%T", err)
	}
}
