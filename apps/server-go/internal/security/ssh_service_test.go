package security

// sshService 的对等测试（对齐 sshService.test.ts 的关键锚定行为，security 盘点 §8）：
// 配置补丁与原子写、启停收敛、Include 展开、Root 凭据、密钥管理、符号链接防线、
// 并发互斥队列。全部经 fake deps（内存文件系统与命令账本）驱动，不执行真实命令。

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/shared"
)

func newTestSshService() (*sshService, *fakeSshDeps, *memFS) {
	deps, fake := newFakeSshDeps()
	svc := newSshService(deps)
	return svc, fake, fake.fs
}

func defaultConfig() string {
	return "# 全局段\nPort 22\nPasswordAuthentication yes\nUsePAM yes\n"
}

func mustNoError(t *testing.T, name string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s 失败：%v", name, err)
	}
}

func mustErrorText(t *testing.T, name string, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s 应失败", name)
	}
	if err.Error() != want {
		t.Errorf("%s 错误文案不符：\n got %q\nwant %q", name, err.Error(), want)
	}
}

// ---------- 配置补丁与原子写 ----------

func TestSetPort补丁与预检与重载(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	fake.writeRunningPid()

	if _, err := svc.SetPort(2202); err != nil {
		t.Fatalf("SetPort 失败：%v", err)
	}

	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.Contains(config, "Port 2202") {
		t.Errorf("配置应写入新端口：%q", config)
	}
	// 备份 + tmp/rename 原子写。
	bak, _ := fs.file("/etc/ssh/sshd_config.bak")
	if bak != defaultConfig() {
		t.Errorf(".bak 应为补丁前原文：%q", bak)
	}
	_, _, renames, _, _, _ := fs.snapshot()
	foundRename := false
	for _, r := range renames {
		if r.From == "/etc/ssh/sshd_config.elysian-tmp" && r.To == "/etc/ssh/sshd_config" {
			foundRename = true
		}
	}
	if !foundRename {
		t.Errorf("tmp 应经 rename 顶替目标文件：%v", renames)
	}
	// sshd -t 预检与 SIGHUP 重载；不出现 service 命令。
	commands := fake.commandsSnapshot()
	hasTest := false
	for _, c := range commands {
		if strings.HasPrefix(c, "sshd -t -f /etc/ssh/sshd_config") {
			hasTest = true
		}
		if strings.Contains(c, "service ") {
			t.Errorf("不得出现 service 命令：%q", c)
		}
	}
	if !hasTest {
		t.Errorf("应执行 sshd -t 预检：%v", commands)
	}
	if fake.reloads == 0 {
		t.Errorf("服务在跑时应 SIGHUP 重载")
	}
}

func TestSetPort预检失败回滚原文(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	fake.writeRunningPid()
	fake.mu.Lock()
	fake.sshdHook = func(args []string) (string, error) {
		if len(args) > 0 && args[0] == "-t" {
			return "", errors.New("sshd: bad configuration")
		}
		return "", nil
	}
	fake.mu.Unlock()

	_, err := svc.SetPort(2202)
	if err == nil {
		t.Fatalf("预检失败应报错")
	}
	wantPrefix := "sshd 配置预检未通过，原配置未改动：sshd: bad configuration"
	if !strings.HasPrefix(err.Error(), wantPrefix) {
		t.Errorf("预检失败文案不符：%q", err.Error())
	}
	// 预检失败按请求被拒（400）返回。
	var invalid *shared.InvalidRequestError
	if !errors.As(err, &invalid) || invalid.Status != 400 {
		t.Errorf("预检失败应映射 400，得 %T", err)
	}
	// 回滚同样走原子写：两次 rename。
	_, _, renames, _, _, _ := fs.snapshot()
	renameCount := 0
	for _, r := range renames {
		if r.To == "/etc/ssh/sshd_config" {
			renameCount++
		}
	}
	if renameCount != 0 {
		t.Errorf("预检失败不得发布配置：%d", renameCount)
	}
	config, _ := fs.file("/etc/ssh/sshd_config")
	if config != defaultConfig() {
		t.Errorf("回滚后配置应恢复原文：%q", config)
	}
}

func TestSetPort重载后死亡回滚(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	fake.writeRunningPid()
	// 重载即死亡：pidfile 被清掉（端口被占用这类只在真实监听时暴露的问题）。
	fake.mu.Lock()
	fake.reloadHook = func() { fs.removeFile(testSshPaths().sshdPidFile) }
	fake.mu.Unlock()

	_, err := svc.SetPort(2202)
	want := "重载后 sshd 进程退出；已恢复 SSH 原配置和服务状态"
	mustErrorText(t, "重载后死亡", err, want)
	config, _ := fs.file("/etc/ssh/sshd_config")
	if config != defaultConfig() {
		t.Errorf("死亡后应回滚原文：%q", config)
	}
	// 服务 stopped 如实呈现。
	overview, err := svc.Overview()
	mustNoError(t, "Overview", err)
	if !overview.Enabled || overview.Status != "running" {
		t.Errorf("回滚后应恢复原运行状态：%+v", overview)
	}
}

func TestSetPort未跑只写不重载(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	// 不写 pidfile：服务未在跑。

	if _, err := svc.SetPort(2202); err != nil {
		t.Fatalf("SetPort 失败：%v", err)
	}
	if fake.reloads != 0 {
		t.Errorf("服务未在跑不应重载：%d", fake.reloads)
	}
	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.Contains(config, "Port 2202") {
		t.Errorf("配置仍应写入：%q", config)
	}
}

func TestSetPort非法端口零写入(t *testing.T) {
	for _, port := range []float64{0, 65536, 22.5} {
		svc, fake, fs := newTestSshService()
		fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
		_, err := svc.SetPort(port)
		mustErrorText(t, "非法端口", err, "SSH 端口需为 1-65535 的整数")
		writes, _, _, chmods, _, _ := fs.snapshot()
		if len(writes) != 0 || len(chmods) != 0 {
			t.Errorf("非法端口应零写入：%v", writes)
		}
		if len(fake.commandsSnapshot()) != 0 {
			t.Errorf("非法端口应零命令：%v", fake.commandsSnapshot())
		}
	}
}

func TestSetAuthMethods双指令(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	settings, err := svc.SetAuthMethods(false, true)
	mustNoError(t, "SetAuthMethods", err)
	if settings.PasswordAuthEnabled || !settings.KeyAuthEnabled {
		t.Errorf("双指令应写入：%+v", settings)
	}
	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.Contains(config, "PasswordAuthentication no") || !strings.Contains(config, "PubkeyAuthentication yes") {
		t.Errorf("配置应含两行：%q", config)
	}
}

func TestSaveRootLoginPolicy枚举校验(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	_, err := svc.SaveRootLoginPolicy("随便")
	mustErrorText(t, "非法策略", err, "无效的 Root 登录策略：随便")
	_, err = svc.SaveRootLoginPolicy("forced-commands-only")
	mustNoError(t, "合法策略", err)
	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.Contains(config, "PermitRootLogin forced-commands-only") {
		t.Errorf("策略应写入：%q", config)
	}
}

func Test幂等补丁不写盘(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "Port 22\n")
	_, err := svc.SetPort(22)
	mustNoError(t, "同值补丁", err)
	writes, _, renames, _, _, _ := fs.snapshot()
	if len(writes) != 0 || len(renames) != 0 {
		t.Errorf("补丁产出与原文相同时不应写盘：%v %v", writes, renames)
	}
}

func Test并发补丁排队不丢改动(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	var wg sync.WaitGroup
	for _, port := range []float64{2202, 2203} {
		wg.Add(1)
		go func(p float64) {
			defer wg.Done()
			if _, err := svc.SetPort(p); err != nil {
				t.Errorf("并发补丁 %v 失败：%v", p, err)
			}
		}(port)
	}
	wg.Wait()
	config, _ := fs.file("/etc/ssh/sshd_config")
	d := parseSshdConfig(config)
	if d.port == nil || (*d.port != 2202 && *d.port != 2203) {
		t.Errorf("并发补丁应串行落盘（最终为其中之一）：%q", config)
	}
	// 只剩一个未注释 Port 行。
	uncommented := 0
	for _, line := range strings.Split(config, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "Port ") {
			uncommented++
		}
	}
	if uncommented != 1 {
		t.Errorf("应只剩一个未注释 Port 行（%d）：%q", uncommented, config)
	}
}

func Test队列失败不阻塞后续(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	fail := true
	fake.mu.Lock()
	fake.sshdHook = func(args []string) (string, error) {
		if len(args) > 0 && args[0] == "-t" && fail {
			return "", errors.New("sshd: bad")
		}
		return "", nil
	}
	fake.mu.Unlock()

	if _, err := svc.SetPort(2202); err == nil {
		t.Fatalf("第一次补丁应失败")
	}
	fail = false
	if _, err := svc.SetPort(2203); err != nil {
		t.Fatalf("第二次补丁失败：%v", err)
	}
	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.Contains(config, "Port 2203") {
		t.Errorf("队列失败不应毒化后续：%q", config)
	}
}

// ---------- Include 展开 ----------

func TestSettings展开Include字典序(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\n")
	// 字典序：b.conf 的 Port 22 先于 z.conf 的 Port 2202 —— first-obtained 取 22。
	fs.writeFile("/etc/ssh/sshd_config.d/b.conf", "Port 22\n")
	fs.writeFile("/etc/ssh/sshd_config.d/z.conf", "Port 2202\nPasswordAuthentication no\n")
	settings, err := svc.Settings()
	mustNoError(t, "Settings", err)
	if settings.Port != 22 || settings.PasswordAuthEnabled {
		t.Errorf("Include 展开按字典序 first-obtained：%+v", settings)
	}
}

func TestSettings展开绝对路径与等号写法(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "Include=/etc/ssh/dropin.conf\nInclude /etc/ssh/missing.conf\n")
	fs.writeFile("/etc/ssh/dropin.conf", "Port=2222\n")
	settings, err := svc.Settings()
	mustNoError(t, "Settings", err)
	if settings.Port != 2222 {
		t.Errorf("等号写法与绝对路径 Include 应展开（缺失文件跳过）：%+v", settings)
	}
}

func Test补丁不动dropIn(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\n")
	fs.writeFile("/etc/ssh/sshd_config.d/b.conf", "Port 22\n")
	if _, err := svc.SetPort(2202); err != nil {
		t.Fatalf("SetPort 失败：%v", err)
	}
	config, _ := fs.file("/etc/ssh/sshd_config")
	if !strings.HasPrefix(config, "Port 2202\nInclude") {
		t.Errorf("面板行应插 Include 之前接管生效：%q", config)
	}
	dropin, _ := fs.file("/etc/ssh/sshd_config.d/b.conf")
	if dropin != "Port 22\n" {
		t.Errorf("补丁不得改动 drop-in 文件：%q", dropin)
	}
}

// ---------- 服务与统计 ----------

func TestOverview由pidfile决定启停与changedAt(t *testing.T) {
	svc, fake, fs := newTestSshService()
	overview, err := svc.Overview()
	mustNoError(t, "Overview", err)
	if overview.Enabled || overview.Status != "stopped" || overview.ChangedAt != nil {
		t.Errorf("无 pidfile 应 stopped 且 changedAt nil：%+v", overview)
	}
	fake.writeRunningPid()
	overview, err = svc.Overview()
	mustNoError(t, "Overview", err)
	if !overview.Enabled || overview.Status != "running" {
		t.Errorf("pidfile 在应 running：%+v", overview)
	}
	// 启停后写 changedAt；新实例可读。
	if _, err := svc.SetServiceEnabled(false); err != nil {
		t.Fatalf("停用失败：%v", err)
	}
	if _, ok := fs.file(testSshPaths().changedAtStamp); !ok {
		t.Errorf("启停成功应写时间戳")
	}
	svc2 := newSshService(svc.deps)
	overview2, err := svc2.Overview()
	mustNoError(t, "Overview2", err)
	if overview2.ChangedAt == nil {
		t.Errorf("新实例应读到 changedAt")
	}
}

func TestPid复用视为未运行且不重载(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	// pidfile 指向 pid 77，comm 是 bash（pid 被无关进程复用）。
	fs.writeFile(testSshPaths().sshdPidFile, "77\n")
	fs.writeFile("/proc/77/comm", "bash\n")
	fake.mu.Lock()
	fake.procComm[77] = "bash\n"
	fake.mu.Unlock()

	running, err := svc.serviceRunning()
	mustNoError(t, "serviceRunning", err)
	if running {
		t.Errorf("pid 复用应按未运行处理")
	}
	if _, err := svc.SetPort(2202); err != nil {
		t.Fatalf("SetPort 失败：%v", err)
	}
	if fake.reloads != 0 {
		t.Errorf("未运行不应重载：%d", fake.reloads)
	}
}

func Test日志只读尾部且截断首行丢弃(t *testing.T) {
	svc, _, fs := newTestSshService()
	big := strings.Repeat("X", 600*1024) + "\nSep 20 08:00:00 host sshd[9]: Failed password for root from 1.2.3.4 port 9 ssh2\n"
	fs.writeFile(testSshPaths().sshdLog, big)

	records, err := svc.ListLoginRecords()
	mustNoError(t, "ListLoginRecords", err)
	if len(records) != 1 || records[0].User != "root" {
		t.Fatalf("只应留下完整事实行：%+v", records)
	}
	// 整读不触达：readText 从未读日志文件。
	_, _, _, _, _, readTexts := fs.snapshot()
	for _, p := range readTexts {
		if p == testSshPaths().sshdLog {
			t.Errorf("日志应只走尾部读取，不得整读")
		}
	}
}

func Test启停收敛与未收敛(t *testing.T) {
	svc, fake, _ := newTestSshService()
	// 启动延迟两个 delay 拍才写 pidfile：回包前等待收敛。
	fake.mu.Lock()
	fake.startAfterDelay = 2
	fake.mu.Unlock()
	overview, err := svc.SetServiceEnabled(true)
	mustNoError(t, "启动", err)
	if !overview.Enabled {
		t.Errorf("启动后应 running：%+v", overview)
	}

	// 永不收敛：启动不写 pidfile。
	svc2, fake2, _ := newTestSshService()
	fake2.mu.Lock()
	fake2.startHook = func() error { return nil }
	fake2.startAfterDelay = 1 << 30 // 永远等不到
	fake2.mu.Unlock()
	_, err = svc2.SetServiceEnabled(true)
	mustErrorText(t, "永不收敛",
		err,
		"SSH 启停未生效：服务状态未在预期时间内收敛，请刷新核对实际状态")
	if _, ok := fake2.fs.file(testSshPaths().changedAtStamp); ok {
		t.Errorf("未收敛不应写时间戳")
	}
}

func TestListLoginRecords倒序与裸行稳定(t *testing.T) {
	svc, _, fs := newTestSshService()
	logText := "Sep 20 08:00:01 host sshd[9]: Accepted password for a from 1.1.1.1 port 1 ssh2\n" +
		"Accepted publickey for b from 2.2.2.2 port 2 ssh2: ED25519 SHA256:x\n" +
		"Sep 20 08:00:03 host sshd[9]: Failed password for c from 3.3.3.3 port 3 ssh2\n"
	fs.writeFile(testSshPaths().sshdLog, logText)

	records, err := svc.ListLoginRecords()
	mustNoError(t, "ListLoginRecords", err)
	if len(records) != 3 {
		t.Fatalf("应解析 3 条：%d", len(records))
	}
	// 倒序：最后一条在最前。
	if records[0].User != "c" || records[2].User != "a" {
		t.Errorf("应按时间倒序：%v", []string{records[0].User, records[1].User, records[2].User})
	}
	if records[0].ID != "login-3" || records[1].ID != "login-2" || records[2].ID != "login-1" {
		t.Errorf("id 顺序敏感（日志增长会移位）：%v", records)
	}
	bareAt := records[1].At
	if bareAt == "" {
		t.Errorf("裸行 at 由会话记忆稳定化")
	}
	// 再次读取：at 跨读取稳定，且统计把裸行计入今日。
	again, err := svc.ListLoginRecords()
	mustNoError(t, "再次读取", err)
	if again[1].At != bareAt {
		t.Errorf("裸行 at 应跨读取稳定：%q vs %q", again[1].At, bareAt)
	}
	overview, err := svc.Overview()
	mustNoError(t, "Overview", err)
	if overview.Stats.Today.Succeeded != 2 || overview.Stats.Today.Failed != 1 {
		t.Errorf("统计应把（时间戳行与裸行）计入今日：%+v", overview.Stats.Today)
	}
}

// ---------- Root 凭据 ----------

func TestResetRootPassword强度与stdin(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())

	_, err := svc.ResetRootPassword("weak")
	mustErrorText(t, "弱密码", err, "密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号")
	if len(fake.chpasswdInputs) != 0 {
		t.Errorf("弱密码不应触 chpasswd：%v", fake.chpasswdInputs)
	}

	_, err = svc.ResetRootPassword("带\n换行")
	mustErrorText(t, "换行密码", err, "密码不能包含换行或控制字符")

	result, err := svc.ResetRootPassword("Str0ngPass!2026")
	mustNoError(t, "强密码", err)
	if result.Strength != "strong" {
		t.Errorf("强度判定：%q", result.Strength)
	}
	if len(fake.chpasswdInputs) != 1 || fake.chpasswdInputs[0] != "root:Str0ngPass!2026" {
		t.Errorf("凭据应经 stdin 下发：%v", fake.chpasswdInputs)
	}
	for _, c := range fake.commandsSnapshot() {
		if strings.Contains(c, "Str0ngPass") {
			t.Errorf("命令行不得出现明文密码：%q", c)
		}
	}
	// passwordResetAt 落盘；新实例可读。
	if _, ok := fs.file(testSshPaths().passwordResetAtStamp); !ok {
		t.Errorf("passwordResetAt 应落盘")
	}
	auth, err := newSshService(svc.deps).RootAuth()
	mustNoError(t, "RootAuth", err)
	if auth.PasswordResetAt == nil {
		t.Errorf("新实例应读到 passwordResetAt")
	}
}

func TestRootAuth策略与密钥(t *testing.T) {
	svc, _, fs := newTestSshService()
	// 空文件 key null；without-password 归一。
	fs.writeFile("/etc/ssh/sshd_config", "PermitRootLogin without-password\n")
	fs.writeFile("/root/.ssh/authorized_keys", "")
	auth, err := svc.RootAuth()
	mustNoError(t, "RootAuth", err)
	if auth.Policy != "prohibit-password" {
		t.Errorf("without-password 应归一：%q", auth.Policy)
	}
	if auth.Key != nil {
		t.Errorf("空文件 key 应为 null")
	}

	// 脏行跳到首个可验证行；有公钥不带私钥。
	foreign := "ssh-rsa AAAAforeign foreign-comment"
	panel := "ssh-ed25519 AAAApanel elysian-root"
	fs.writeFile("/root/.ssh/authorized_keys", "garbage line\n"+foreign+"\n"+panel+"\n")
	auth, err = svc.RootAuth()
	mustNoError(t, "RootAuth", err)
	if auth.Key == nil || auth.Key.PublicKey != foreign {
		t.Fatalf("应取首个可验证行（外来行）：%+v", auth.Key)
	}
	if auth.Key.PrivateKey != nil {
		t.Errorf("rootAuth 不返回私钥")
	}
	if auth.Key.Algorithm != "ssh-rsa 2048" {
		t.Errorf("算法呈现：%q", auth.Key.Algorithm)
	}
}

func TestCreateRootKey首行替换与权限(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "PermitRootLogin yes\n")
	old := "ssh-ed25519 AAAAold elysian-old"
	foreign := "ssh-ed25519 AAAAforeign foreign-comment"
	fs.writeFile("/root/.ssh/authorized_keys", "# 注释\n"+old+"\n"+foreign+"\n")

	auth, err := svc.CreateRootKey()
	mustNoError(t, "CreateRootKey", err)
	if auth.Key == nil || auth.Key.PrivateKey == nil {
		t.Fatalf("生成响应应携带一次性私钥")
	}
	if *auth.Key.PrivateKey == "" || strings.Contains(*auth.Key.PrivateKey, "AAAAfake") {
		t.Errorf("私钥应为生成的私钥文件内容")
	}
	content, _ := fs.file("/root/.ssh/authorized_keys")
	lines := ParseKeyLines(content)
	if len(lines) != 2 || lines[0] != auth.Key.PublicKey || lines[1] != foreign {
		t.Errorf("首行替换、外来行保留：%q", content)
	}
	if !strings.Contains(auth.Key.PublicKey, "elysian-root") {
		t.Errorf("root 固定注释 elysian-root：%q", auth.Key.PublicKey)
	}
	// 权限与属主：目录 0700、文件 0600，chown 0:0。
	_, removes, _, chmods, chowns, _ := fs.snapshot()
	hasDir, hasFile := false, false
	for _, c := range chmods {
		if c.Path == "/root/.ssh" && c.Mode == 0o700 {
			hasDir = true
		}
		if c.Path == "/root/.ssh/authorized_keys.elysian-tmp" && c.Mode == 0o600 {
			hasFile = true
		}
	}
	if !hasDir || !hasFile {
		t.Errorf("权限应收紧：%v", chmods)
	}
	for _, c := range chowns {
		if (c.Path == "/root/.ssh" || c.Path == "/root/.ssh/authorized_keys.elysian-tmp") && (c.UID != 0 || c.GID != 0) {
			t.Errorf("root 属主应为 0:0：%v", c)
		}
	}
	// 私钥不落盘：authorized_keys 与 .bak 都不得含私钥；临时密钥文件删除（私钥与 .pub 各一）。
	bakContent, _ := fs.file("/root/.ssh/authorized_keys.bak")
	for name, text := range map[string]string{"authorized_keys": content, ".bak": bakContent} {
		if strings.Contains(text, "BEGIN PRIVATE KEY") {
			t.Errorf("私钥不得落盘（%s）：%q", name, text)
		}
	}
	keyRemoves := 0
	for _, p := range removes {
		if strings.Contains(p, "elysian-root-key") {
			keyRemoves++
		}
	}
	if keyRemoves != 2 {
		t.Errorf("私钥与 .pub 两份临时文件都应删除：%v", removes)
	}
	_ = fake
}

func TestCreateRootKey文件不存在时新建(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", "PermitRootLogin yes\n")
	auth, err := svc.CreateRootKey()
	mustNoError(t, "CreateRootKey", err)
	content, ok := fs.file("/root/.ssh/authorized_keys")
	if !ok || strings.TrimSpace(content) != auth.Key.PublicKey {
		t.Errorf("文件不存在时应新建且只剩新行：%q", content)
	}
}

// ---------- 登录密钥 ----------

func TestKeyAccounts白名单(t *testing.T) {
	svc, _, _ := newTestSshService()
	accounts, err := svc.KeyAccounts()
	mustNoError(t, "KeyAccounts", err)
	// root（uid 0）与无可归属账号排除；两个 uid≥1000 的登录账号都在。
	if len(accounts) != 2 || accounts[0].ID != "elysian" || accounts[1].ID != "newops" {
		t.Errorf("白名单过滤失败：%+v", accounts)
	}
}

func TestCreateKey生成参数与落盘与权限(t *testing.T) {
	svc, fake, fs := newTestSshService()
	key, err := svc.CreateKey("部署机", "elysian")
	mustNoError(t, "CreateKey", err)
	if key.UserID != "elysian" || key.Name != "部署机" || key.PrivateKey == nil {
		t.Fatalf("响应字段缺失：%+v", key)
	}
	// 生成参数逐字：-t ed25519 -C elysian-部署机 -N '' -f <工作区>/elysian-key-*。
	found := false
	for _, c := range fake.commandsSnapshot() {
		if strings.HasPrefix(c, "ssh-keygen -t ed25519 -C elysian-部署机 -N  -f ") && strings.Contains(c, "/elysian-key-") {
			found = true
		}
	}
	if !found {
		t.Errorf("生成参数不符：%v", fake.commandsSnapshot())
	}
	// 公钥行落盘。
	content, _ := fs.file("/home/elysian/.ssh/authorized_keys")
	if !strings.Contains(content, key.PublicKey) || !strings.HasSuffix(content, "\n") {
		t.Errorf("公钥应追加落盘：%q", content)
	}
	if !strings.Contains(key.PublicKey, "elysian-部署机") {
		t.Errorf("注释应带名称：%q", key.PublicKey)
	}
	// 权限与属主：0700/0600、chown 1000:1000。
	_, _, _, chmods, chowns, _ := fs.snapshot()
	for _, c := range chmods {
		if c.Path == "/home/elysian/.ssh" && c.Mode != 0o700 {
			t.Errorf(".ssh 应 0700：%v", c)
		}
		if c.Path == "/home/elysian/.ssh/authorized_keys.elysian-tmp" && c.Mode != 0o600 {
			t.Errorf("authorized_keys 应 0600：%v", c)
		}
	}
	for _, c := range chowns {
		if (c.Path == "/home/elysian/.ssh" || c.Path == "/home/elysian/.ssh/authorized_keys.elysian-tmp") && (c.UID != 1000 || c.GID != 1000) {
			t.Errorf("属主应落到账号名下：%v", c)
		}
	}
	// 私钥一次性：列表不再返回。
	report, err := svc.ListKeysWithReport()
	mustNoError(t, "ListKeysWithReport", err)
	if len(report.Keys) != 1 || report.Keys[0].PrivateKey != nil {
		t.Errorf("列表不带私钥：%+v", report.Keys)
	}
	if report.Keys[0].ID != key.ID || report.Keys[0].Name != "部署机" {
		t.Errorf("列表条目应与创建一致：%+v", report.Keys[0])
	}
}

func TestCreateKey名称防线零命令(t *testing.T) {
	for _, c := range []struct {
		name    string
		rawName string
		want    string
	}{
		{"带换行", "名\n称", "密钥名称不能包含换行或控制字符"},
		{"纯空白", "   ", "密钥名称需为 1-32 个字符"},
		{"超长", strings.Repeat("长", 33), "密钥名称需为 1-32 个字符"},
	} {
		svc, fake, _ := newTestSshService()
		_, err := svc.CreateKey(c.rawName, "elysian")
		mustErrorText(t, c.name, err, c.want)
		if len(fake.commandsSnapshot()) != 0 {
			t.Errorf("%s：名称校验先于一切命令：%v", c.name, fake.commandsSnapshot())
		}
	}
}

func TestCreateKey名称与账号防线(t *testing.T) {
	cases := []struct {
		name    string
		userId  string
		wantErr string
	}{
		{"root 归属", "root", "归属账号不存在：root"},
		{"路径穿越", "../../etc", "归属账号不存在：../../etc"},
		{"系统账号", "svc", "归属账号不存在：svc"},
	}
	for _, c := range cases {
		svc, _, fs := newTestSshService()
		_, err := svc.CreateKey("合法名称", c.userId)
		mustErrorText(t, c.name, err, c.wantErr)
		// 名称类拒绝发生在任何 getent 之前（零命令）；账号类拒绝发生在白名单
		// 反查之后（只读命令），两者都不得有任何写盘。
		writes, _, _, chmods, chowns, _ := fs.snapshot()
		if len(writes) != 0 || len(chmods) != 0 || len(chowns) != 0 {
			t.Errorf("%s：应零写盘：%v", c.name, writes)
		}
		for _, w := range writes {
			if w.Path == "/etc/.ssh/authorized_keys" {
				t.Errorf("%s：不得写穿越路径", c.name)
			}
		}
	}
}

func TestCreateKey重名拒绝(t *testing.T) {
	svc, _, _ := newTestSshService()
	if _, err := svc.CreateKey("部署机", "elysian"); err != nil {
		t.Fatalf("首次创建失败：%v", err)
	}
	_, err := svc.CreateKey("部署机", "elysian")
	mustErrorText(t, "重名", err, "密钥名称已存在：部署机")
}

func TestRemoveKey级联与未知id(t *testing.T) {
	svc, _, fs := newTestSshService()
	key, err := svc.CreateKey("部署机", "elysian")
	mustNoError(t, "CreateKey", err)
	before, _ := fs.file("/home/elysian/.ssh/authorized_keys")

	mustNoError(t, "RemoveKey", svc.RemoveKey(key.ID))
	after, _ := fs.file("/home/elysian/.ssh/authorized_keys")
	if strings.Contains(after, key.PublicKey) {
		t.Errorf("公钥行应被删除：%q", after)
	}
	// 写前备份保留了删除前内容。
	bak, _ := fs.file("/home/elysian/.ssh/authorized_keys.bak")
	if bak != before {
		t.Errorf(".bak 应为删除前内容：%q", bak)
	}
	err = svc.RemoveKey(key.ID)
	mustErrorText(t, "再次删除", err, fmt.Sprintf("未找到登录密钥 %s", key.ID))
}

func Test外来公钥按注释呈现(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/home/elysian/.ssh/authorized_keys", "ssh-rsa AAAAforeign ops@laptop\n")
	report, err := svc.ListKeysWithReport()
	mustNoError(t, "ListKeysWithReport", err)
	if len(report.Keys) != 1 || report.Keys[0].Name != "ops@laptop" {
		t.Errorf("外来行按注释原样呈现：%+v", report.Keys)
	}
	if report.IgnoredInvalidLines != 0 {
		t.Errorf("外来行可验证不应计入脏行：%d", report.IgnoredInvalidLines)
	}
}

func Test同公钥多账号id各异按id各删各的(t *testing.T) {
	svc, _, fs := newTestSshService()
	line := "ssh-ed25519 AAAAshared shared-comment"
	fs.writeFile("/home/elysian/.ssh/authorized_keys", line+"\n")
	fs.writeFile("/home/newops/.ssh/authorized_keys", line+"\n")

	report, err := svc.ListKeysWithReport()
	mustNoError(t, "ListKeysWithReport", err)
	if len(report.Keys) != 2 {
		t.Fatalf("两个账号各一把：%d", len(report.Keys))
	}
	idA, idB := report.Keys[0].ID, report.Keys[1].ID
	if idA == idB {
		t.Fatalf("同公钥不同账号 id 应不同")
	}
	mustNoError(t, "RemoveKey", svc.RemoveKey(idA))
	elysianText, _ := fs.file("/home/elysian/.ssh/authorized_keys")
	newopsText, _ := fs.file("/home/newops/.ssh/authorized_keys")
	if strings.Contains(elysianText, line) {
		t.Errorf("目标账号的行应删除：%q", elysianText)
	}
	if !strings.Contains(newopsText, line) {
		t.Errorf("其他账号的同款公钥不受影响：%q", newopsText)
	}
}

func Test并发createKey两把都留下(t *testing.T) {
	svc, _, _ := newTestSshService()
	var wg sync.WaitGroup
	for _, name := range []string{"甲", "乙"} {
		wg.Add(1)
		go func(n string) {
			defer wg.Done()
			if _, err := svc.CreateKey(n, "elysian"); err != nil {
				t.Errorf("并发创建 %s 失败：%v", n, err)
			}
		}(name)
	}
	wg.Wait()
	report, err := svc.ListKeysWithReport()
	mustNoError(t, "ListKeysWithReport", err)
	if len(report.Keys) != 2 {
		t.Errorf("两把都应留下（互斥队列不丢写）：%d", len(report.Keys))
	}
}

func Test脏行跳过计数不拖垮创建(t *testing.T) {
	svc, _, fs := newTestSshService()
	fs.writeFile("/home/elysian/.ssh/authorized_keys", "garbage\n")
	report, err := svc.ListKeysWithReport()
	mustNoError(t, "ListKeysWithReport", err)
	if report.IgnoredInvalidLines != 1 {
		t.Errorf("脏行应计数：%d", report.IgnoredInvalidLines)
	}
	_, err = svc.CreateKey("部署机", "elysian")
	mustNoError(t, "脏行不拖垮创建", err)
}

func Test密钥队列失败不阻塞(t *testing.T) {
	svc, fake, _ := newTestSshService()
	fake.mu.Lock()
	fake.keygenHook = func(args []string) (string, error) {
		if len(args) > 0 && args[0] == "-t" {
			return "", errors.New("keygen boom")
		}
		return fake.defaultKeygen(args)
	}
	fake.mu.Unlock()
	if _, err := svc.CreateKey("甲", "elysian"); err == nil {
		t.Fatalf("第一次应失败")
	}
	// 恢复默认行为后再创建应成功（队列未被毒化）。
	fake.mu.Lock()
	fake.keygenHook = nil
	fake.mu.Unlock()
	if _, err := svc.CreateKey("乙", "elysian"); err != nil {
		t.Fatalf("队列失败不应阻塞后续：%v", err)
	}
}

// ---------- 符号链接防线 ----------

func Test符号链接防线(t *testing.T) {
	paths := []struct {
		link  string
		label string
	}{
		{"/home/elysian/.ssh", "账号的 .ssh 目录"},
		{"/home/elysian/.ssh/authorized_keys", "authorized_keys 文件"},
		{"/home/elysian/.ssh/authorized_keys.bak", "写前备份"},
		{"/home/elysian/.ssh/authorized_keys.elysian-tmp", "原子写的临时文件"},
	}
	for _, p := range paths {
		svc, _, fs := newTestSshService()
		// 先有一份合法原文：写前备份检查只在 original 非 nil 时发生。
		fs.writeFile("/home/elysian/.ssh/authorized_keys", "ssh-ed25519 AAAAold c\n")
		fs.addSymlink(p.link)
		_, err := svc.CreateKey("部署机", "elysian")
		want := fmt.Sprintf(
			"安全检查未通过：%s（%s）是符号链接，已拒绝写入。面板不跟随符号链接写系统文件，请人工检查该路径是否被篡改",
			p.label, p.link,
		)
		mustErrorText(t, "符号链接 "+p.label, err, want)
		// chmod/chown/写盘不得经链接作用到被链接的路径本身（目录自身的权限
		// 收紧发生在防线通过之后，允许发生）。
		writes, _, _, chmods, chowns, _ := fs.snapshot()
		for _, c := range chmods {
			if c.Path == p.link {
				t.Errorf("%s：chmod 不得作用于链接路径：%v", p.label, c)
			}
		}
		for _, c := range chowns {
			if c.Path == p.link {
				t.Errorf("%s：chown 不得作用于链接路径：%v", p.label, c)
			}
		}
		for _, w := range writes {
			if w.Path == p.link {
				t.Errorf("%s：写盘不得作用于链接路径：%q", p.label, w.Path)
			}
		}
	}

	// sshd_config 的 .bak 预置链接：拒绝补丁且配置原样。
	svc, _, fs := newTestSshService()
	fs.writeFile("/etc/ssh/sshd_config", defaultConfig())
	fs.addSymlink("/etc/ssh/sshd_config.bak")
	_, err := svc.SetPort(2202)
	want := "安全检查未通过：写前备份（/etc/ssh/sshd_config.bak）是符号链接，已拒绝写入。面板不跟随符号链接写系统文件，请人工检查该路径是否被篡改"
	mustErrorText(t, "配置备份链接", err, want)
	config, _ := fs.file("/etc/ssh/sshd_config")
	if config != defaultConfig() {
		t.Errorf("配置应原样：%q", config)
	}
}

func TestSetServiceEnabledStartIdempotentWhenRunning(t *testing.T) {
	svc, fake, fs := newTestSshService()
	fake.writeRunningPid()

	overview, err := svc.SetServiceEnabled(true)
	if err != nil {
		t.Fatalf("sshd 已在跑时启用应成功：%v", err)
	}
	if fake.starts != 0 {
		t.Fatalf("已在跑不应再 spawn 第二个 sshd（同端口必败），实际 spawn %d 次", fake.starts)
	}
	if !overview.Enabled || overview.Status != "running" {
		t.Fatalf("应保持运行态：%+v", overview)
	}
	if _, ok := fs.file(testSshPaths().changedAtStamp); !ok {
		t.Fatal("幂等启用也应写 changedAt 时间戳")
	}
}

func TestSetServiceEnabledStartSpawnsWhenStopped(t *testing.T) {
	svc, fake, _ := newTestSshService()

	if _, err := svc.SetServiceEnabled(true); err != nil {
		t.Fatalf("停机状态启用应成功：%v", err)
	}
	if fake.starts != 1 {
		t.Fatalf("停机状态应 spawn 一次，实际 %d 次", fake.starts)
	}
	overview, err := svc.Overview()
	mustNoError(t, "Overview", err)
	if !overview.Enabled || overview.Status != "running" {
		t.Fatalf("启动后应运行中：%+v", overview)
	}
}
