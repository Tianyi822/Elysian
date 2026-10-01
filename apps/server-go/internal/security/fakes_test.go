package security

// 测试假件（对齐 TS 版 Vitest 的有状态 fake）：内存文件系统（含符号链接与命令
// 账本）、getent 账号库、路由层 fake service。测试不执行任何真实命令。

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
)

// ---------- 内存文件系统 ----------

type memWrite struct {
	Path    string
	Content string
}

type memChmod struct {
	Path string
	Mode uint32
}

type memChown struct {
	Path string
	UID  int
	GID  int
}

type memRename struct {
	From string
	To   string
}

// memFS 内存文件系统：文件、目录、符号链接占位与全部文件原语调用账本。
type memFS struct {
	mu           sync.Mutex
	files        map[string]string
	dirs         map[string]bool
	symlinks     map[string]bool
	writes       []memWrite
	removes      []string
	renames      []memRename
	chmods       []memChmod
	chowns       []memChown
	readTexts    []string
	readTextTail []string
}

func newMemFS() *memFS {
	return &memFS{
		files:    map[string]string{},
		dirs:     map[string]bool{},
		symlinks: map[string]bool{},
	}
}

func (m *memFS) writeFile(path, content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.files[path] = content
}

func (m *memFS) file(path string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	content, ok := m.files[path]
	return content, ok
}

func (m *memFS) addSymlink(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.symlinks[path] = true
}

func (m *memFS) removeFile(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.files, path)
	delete(m.symlinks, path)
}

// attach 把文件系统接到 sshHostDeps 的文件原语上。
func (m *memFS) attach(deps *sshHostDeps) {
	deps.readText = func(path string) (string, error) {
		m.mu.Lock()
		m.readTexts = append(m.readTexts, path)
		content, ok := m.files[path]
		m.mu.Unlock()
		if !ok {
			return "", &os.PathError{Op: "open", Path: path, Err: os.ErrNotExist}
		}
		return content, nil
	}
	deps.readTextTail = func(path string, maxBytes int64) (string, error) {
		m.mu.Lock()
		m.readTextTail = append(m.readTextTail, path)
		content, ok := m.files[path]
		m.mu.Unlock()
		if !ok {
			return "", &os.PathError{Op: "open", Path: path, Err: os.ErrNotExist}
		}
		data := content
		truncated := false
		if int64(len(data)) > maxBytes {
			data = data[int64(len(data))-maxBytes:]
			truncated = true
		}
		return textTailOf(data, truncated), nil
	}
	deps.readDir = func(path string) ([]string, error) {
		m.mu.Lock()
		defer m.mu.Unlock()
		prefix := strings.TrimSuffix(path, "/") + "/"
		seen := map[string]bool{}
		for name := range m.files {
			if strings.HasPrefix(name, prefix) && !strings.Contains(strings.TrimPrefix(name, prefix), "/") {
				seen[strings.TrimPrefix(name, prefix)] = true
			}
		}
		names := make([]string, 0, len(seen))
		for name := range seen {
			names = append(names, name)
		}
		return names, nil
	}
	deps.writeText = func(path, content string) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.symlinks[path] {
			return &os.PathError{Op: "open", Path: path, Err: errors.New("too many levels of symbolic links")}
		}
		m.writes = append(m.writes, memWrite{Path: path, Content: content})
		m.files[path] = content
		return nil
	}
	deps.exists = func(path string) bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, isFile := m.files[path]
		return isFile || m.dirs[path] || m.symlinks[path]
	}
	deps.lstat = func(path string) (bool, error) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.symlinks[path] {
			return true, nil
		}
		if _, ok := m.files[path]; ok {
			return false, nil
		}
		if m.dirs[path] {
			return false, nil
		}
		return false, &os.PathError{Op: "lstat", Path: path, Err: os.ErrNotExist}
	}
	deps.rename = func(from, to string) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		content, ok := m.files[from]
		if !ok {
			return &os.PathError{Op: "rename", Path: from, Err: os.ErrNotExist}
		}
		m.renames = append(m.renames, memRename{From: from, To: to})
		delete(m.files, from)
		m.files[to] = content
		return nil
	}
	deps.chmod = func(path string, mode uint32) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.chmods = append(m.chmods, memChmod{Path: path, Mode: mode})
		return nil
	}
	deps.chown = func(path string, uid, gid int) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.chowns = append(m.chowns, memChown{Path: path, UID: uid, GID: gid})
		return nil
	}
	deps.mkdir = func(path string) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.dirs[path] = true
		return nil
	}
	deps.remove = func(path string) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		delete(m.files, path)
		m.removes = append(m.removes, path)
		return nil
	}
}

// snapshot 在锁内取一份账本快照（断言用）。
func (m *memFS) snapshot() (writes []memWrite, removes []string, renames []memRename, chmods []memChmod, chowns []memChown, readTexts []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]memWrite{}, m.writes...), append([]string{}, m.removes...),
		append([]memRename{}, m.renames...), append([]memChmod{}, m.chmods...),
		append([]memChown{}, m.chowns...), append([]string{}, m.readTexts...)
}

// ---------- SSH 域 fake deps ----------

// testSshPaths 固定的假路径表（全部落在 memFS 里，不触达宿主机）。
func testSshPaths() sshPaths {
	return sshPaths{
		sshdConfig:           "/etc/ssh/sshd_config",
		sshdLog:              "/var/elysian-test/logs/sshd.log",
		sshdPidFile:          "/run/sshd.pid",
		keygenWorkspace:      "/var/elysian-test/tmp/ssh-keygen",
		changedAtStamp:       "/var/elysian-test/state/ssh-changed-at",
		passwordResetAtStamp: "/var/elysian-test/state/ssh-root-password-reset-at",
	}
}

// fakeSshDeps SSH 域的命令与生命周期账本。
type fakeSshDeps struct {
	fs              *memFS
	mu              sync.Mutex
	commands        []string
	chpasswdInputs  []string
	signals         []string
	starts          int
	reloads         int
	getentCalls     [][]string
	delayCalls      int
	keygenHook      func(args []string) (string, error)
	sshdHook        func(args []string) (string, error)
	startHook       func() error
	reloadHook      func()
	chpasswdHook    func(input string) error
	passwdOutput    string
	nowIsoValue     string
	pidFileText     string
	procComm        map[int]string
	startAfterDelay int
	pendingStarts   int
}

// newFakeSshDeps 构造默认成功的 fake（生成 ed25519、验证公钥、sshd -t 通过、
// getent 返回 root + 联调账号）。
func newFakeSshDeps() (*sshHostDeps, *fakeSshDeps) {
	fs := newMemFS()
	fake := &fakeSshDeps{
		fs:          fs,
		nowIsoValue: "2026-09-20T10:00:00.000Z",
		procComm:    map[int]string{},
		passwdOutput: strings.Join([]string{
			"root:x:0:0:root:/root:/bin/bash",
			"elysian:x:1000:1000::/home/elysian:/bin/bash",
			"newops:x:1010:1010::/home/newops:/bin/bash",
		}, "\n"),
	}
	paths := testSshPaths()
	deps := &sshHostDeps{pathsOverride: &paths}
	fs.attach(deps)

	deps.runSshKeygen = func(args []string) (string, error) {
		fake.mu.Lock()
		hook := fake.keygenHook
		fake.mu.Unlock()
		if hook != nil {
			return hook(args)
		}
		return fake.defaultKeygen(args)
	}
	deps.runSshd = func(args []string) (string, error) {
		fake.record("sshd " + strings.Join(args, " "))
		fake.mu.Lock()
		hook := fake.sshdHook
		fake.mu.Unlock()
		if hook != nil {
			return hook(args)
		}
		return "", nil
	}
	deps.startSshd = func() error {
		fake.mu.Lock()
		fake.starts++
		after := fake.startAfterDelay
		fake.mu.Unlock()
		fake.record("sshd-start -E " + paths.sshdLog)
		if after <= 0 {
			fake.writeRunningPid()
			return nil
		}
		fake.mu.Lock()
		fake.pendingStarts = after
		fake.mu.Unlock()
		return nil
	}
	deps.stopSshd = func() error {
		fake.record("sshd-stop")
		pid, ok := fake.resolveRunningPid()
		if !ok {
			return nil
		}
		fake.mu.Lock()
		fake.signals = append(fake.signals, fmt.Sprintf("SIGTERM %d", pid))
		delete(fake.procComm, pid)
		fake.mu.Unlock()
		fake.fs.removeFile(paths.sshdPidFile)
		return nil
	}
	deps.reloadSshd = func() error {
		fake.mu.Lock()
		fake.reloads++
		hook := fake.reloadHook
		fake.mu.Unlock()
		fake.record("sshd-reload")
		if hook != nil {
			hook()
		}
		return nil
	}
	deps.runChpasswd = func(input string) (string, error) {
		fake.mu.Lock()
		fake.chpasswdInputs = append(fake.chpasswdInputs, input)
		hook := fake.chpasswdHook
		fake.mu.Unlock()
		fake.record("chpasswd")
		if hook != nil {
			if err := hook(input); err != nil {
				return "", err
			}
		}
		return "", nil
	}
	deps.runGetent = func(args []string) (string, error) {
		fake.mu.Lock()
		fake.getentCalls = append(fake.getentCalls, append([]string{}, args...))
		output := fake.passwdOutput
		fake.mu.Unlock()
		fake.record("getent " + strings.Join(args, " "))
		if len(args) >= 2 && args[0] == "passwd" {
			name := args[1]
			for _, line := range strings.Split(output, "\n") {
				if strings.HasPrefix(line, name+":") {
					return line, nil
				}
			}
			return "", nil
		}
		return output, nil
	}
	deps.delay = func(ms int) {
		fake.mu.Lock()
		fake.delayCalls++
		fake.pendingStarts--
		pending := fake.pendingStarts
		fake.mu.Unlock()
		if pending <= 0 {
			fake.writeRunningPid()
		}
	}
	deps.nowIso = func() string {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.nowIsoValue
	}
	return deps, fake
}

// record 记一条命令账本。
func (f *fakeSshDeps) record(command string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, command)
}

// writeRunningPid 写入运行中的 sshd pidfile 与 comm。
func (f *fakeSshDeps) writeRunningPid() {
	f.mu.Lock()
	pid := 4242
	f.procComm[pid] = "sshd\n"
	text := fmt.Sprintf("%d\n", pid)
	f.pidFileText = text
	f.mu.Unlock()
	f.fs.writeFile(testSshPaths().sshdPidFile, text)
	f.fs.writeFile(fmt.Sprintf("/proc/%d/comm", pid), "sshd\n")
}

// resolveRunningPid 模拟 pidfile+comm 双核实。
func (f *fakeSshDeps) resolveRunningPid() (int, bool) {
	text, ok := f.fs.file(testSshPaths().sshdPidFile)
	if !ok {
		return 0, false
	}
	pid, valid := jsParseInt(strings.TrimSpace(text))
	if !valid {
		return 0, false
	}
	f.mu.Lock()
	comm, hasComm := f.procComm[pid]
	f.mu.Unlock()
	if !hasComm || strings.TrimSpace(comm) != "sshd" {
		return 0, false
	}
	return pid, true
}

// defaultKeygen 默认 ssh-keygen 行为：-lf 验证公钥行，-t 生成密钥对。
func (f *fakeSshDeps) defaultKeygen(args []string) (string, error) {
	f.record("ssh-keygen " + strings.Join(args, " "))
	if len(args) >= 2 && args[0] == "-lf" {
		path := args[1]
		content, _ := f.fs.file(path)
		line := strings.TrimSpace(content)
		return fingerprintLineFor(line)
	}
	if len(args) >= 2 && args[0] == "-t" {
		keyPath := args[len(args)-1]
		comment := ""
		for i, arg := range args {
			if arg == "-C" && i+1 < len(args) {
				comment = args[i+1]
			}
		}
		material := fmt.Sprintf("ssh-ed25519 AAAAfake-%s %s", comment, comment)
		f.fs.writeFile(keyPath, "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n")
		f.fs.writeFile(keyPath+".pub", material+"\n")
		return "", nil
	}
	return "", nil
}

// fingerprintLineFor 由公钥行生成 -lf 形状输出；非法行报错。
func fingerprintLineFor(line string) (string, error) {
	fields := strings.Fields(line)
	bitsToken := map[string]string{
		"ssh-ed25519":         "ED25519",
		"ssh-rsa":             "RSA",
		"ecdsa-sha2-nistp256": "ECDSA",
		"ssh-dss":             "DSA",
	}
	bitsOf := map[string]int{"ssh-ed25519": 256, "ssh-rsa": 2048, "ecdsa-sha2-nistp256": 256, "ssh-dss": 1024}
	token, ok := bitsToken[fields[0]]
	if len(fields) < 2 || !ok {
		return "", errors.New("ssh-keygen: is not a valid public key file")
	}
	comment := ""
	if len(fields) >= 3 {
		comment = strings.Join(fields[2:], " ")
	}
	return fmt.Sprintf("%d SHA256:%s %s (%s)", bitsOf[fields[0]], fnv1a(line), comment, token), nil
}

// setNowIso 固定时间源。
func (f *fakeSshDeps) setNowIso(iso string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nowIsoValue = iso
}

// commandsSnapshot 命令账本快照。
func (f *fakeSshDeps) commandsSnapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.commands...)
}

// ---------- 用户域 fake deps（带状态回放的账号库） ----------

// fakeUsersDeps 用户域命令与账号库账本。
type fakeUsersDeps struct {
	mu             sync.Mutex
	fs             *memFS
	passwd         []string
	shadow         []string
	sudoLine       string
	commands       []string
	chpasswdInputs []string
	getentCalls    [][]string
	nowIsoValue    string
	nextUID        int
	chpasswdHook   func(input string) error
}

// newFakeUsersDeps 标准账号库：root、系统账号、两个可管理账号与 sudo 组。
func newFakeUsersDeps() (*usersHostDeps, *fakeUsersDeps) {
	fs := newMemFS()
	fake := &fakeUsersDeps{
		fs: fs,
		passwd: []string{
			"root:x:0:0:root:/root:/bin/bash",
			"svc:x:999:999::/home/svc:/usr/sbin/nologin",
			"elysian:x:1000:1000::/home/elysian:/bin/bash",
			"newops:x:1010:1010::/home/newops:/bin/bash",
			"far:x:60001:60001::/home/far:/bin/bash",
			"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
		},
		shadow: []string{
			"root:$6$hashroot:20000:0:99999:7:::",
			"svc:!:20000:0:99999:7:::",
			"elysian:*:20000:0:99999:7:::",
			"newops:$6$hashops:20000:0:99999:7:::",
			"far:*:20000:0:99999:7:::",
			"nobody:!:20000:0:99999:7:::",
		},
		sudoLine:    "sudo:x:27:elysian",
		nowIsoValue: "2026-09-20T10:00:00.000Z",
		nextUID:     1100,
	}
	deps := &usersHostDeps{}
	deps.runGetent = func(args []string) (string, error) {
		fake.mu.Lock()
		fake.getentCalls = append(fake.getentCalls, append([]string{}, args...))
		passwd := append([]string{}, fake.passwd...)
		shadow := append([]string{}, fake.shadow...)
		sudoLine := fake.sudoLine
		fake.mu.Unlock()
		fake.record("getent " + strings.Join(args, " "))
		switch {
		case len(args) == 1 && args[0] == "passwd":
			return strings.Join(passwd, "\n"), nil
		case len(args) == 2 && args[0] == "passwd":
			for _, line := range passwd {
				if strings.HasPrefix(line, args[1]+":") {
					return line, nil
				}
			}
			return "", nil // 退出码 2 归一为空输出
		case len(args) == 1 && args[0] == "shadow":
			return strings.Join(shadow, "\n"), nil
		case len(args) == 2 && args[0] == "shadow":
			for _, line := range shadow {
				if strings.HasPrefix(line, args[1]+":") {
					return line, nil
				}
			}
			return "", nil
		case len(args) == 2 && args[0] == "group" && args[1] == "sudo":
			return sudoLine, nil
		}
		return "", nil
	}
	deps.runUseradd = func(args []string) (string, error) {
		fake.record("useradd " + strings.Join(args, " "))
		return "", fake.applyUseradd(args)
	}
	deps.runUsermod = func(args []string) (string, error) {
		fake.record("usermod " + strings.Join(args, " "))
		return "", fake.applyUsermod(args)
	}
	deps.runUserdel = func(args []string) (string, error) {
		fake.record("userdel " + strings.Join(args, " "))
		fake.applyUserdel(args[0])
		return "", nil
	}
	deps.runGpasswd = func(args []string) (string, error) {
		fake.record("gpasswd " + strings.Join(args, " "))
		return "", fake.applyGpasswd(args)
	}
	deps.runChpasswd = func(input string) (string, error) {
		fake.mu.Lock()
		fake.chpasswdInputs = append(fake.chpasswdInputs, input)
		hook := fake.chpasswdHook
		fake.mu.Unlock()
		fake.record("chpasswd")
		if hook != nil {
			if err := hook(input); err != nil {
				return "", err
			}
		}
		name, _, _ := strings.Cut(input, ":")
		fake.setShadowHash(name, "hashed:"+strings.TrimPrefix(input, name+":"))
		return "", nil
	}
	deps.readText = func(path string) (string, error) {
		content, ok := fs.file(path)
		if !ok {
			return "", &os.PathError{Op: "open", Path: path, Err: os.ErrNotExist}
		}
		return content, nil
	}
	deps.exists = func(path string) bool {
		_, ok := fs.file(path)
		return ok
	}
	deps.remove = func(path string) error {
		if _, ok := fs.file(path); !ok {
			return &os.PathError{Op: "unlink", Path: path, Err: os.ErrNotExist}
		}
		fs.removeFile(path)
		return nil
	}
	deps.nowIso = func() string {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.nowIsoValue
	}
	return deps, fake
}

// record 记一条命令账本。
func (f *fakeUsersDeps) record(command string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, command)
}

// commandsSnapshot 命令账本快照。
func (f *fakeUsersDeps) commandsSnapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.commands...)
}

// passwdLine 取账号的 passwd 行字段。
func (f *fakeUsersDeps) passwdLine(name string) ([]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, line := range f.passwd {
		if strings.HasPrefix(line, name+":") {
			return strings.Split(line, ":"), true
		}
	}
	return nil, false
}

// setShadowHash 更新 shadow 哈希字段。
func (f *fakeUsersDeps) setShadowHash(name, hash string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, line := range f.shadow {
		if strings.HasPrefix(line, name+":") {
			fields := strings.Split(line, ":")
			fields[1] = hash
			f.shadow[i] = strings.Join(fields, ":")
			return
		}
	}
}

// setShadowExpire 更新 shadow 过期日字段。
func (f *fakeUsersDeps) setShadowExpire(name string, expire string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, line := range f.shadow {
		if strings.HasPrefix(line, name+":") {
			fields := strings.Split(line, ":")
			for len(fields) < 8 {
				fields = append(fields, "")
			}
			fields[7] = expire
			f.shadow[i] = strings.Join(fields, ":")
			return
		}
	}
}

// applyUseradd 模拟 useradd 的账号库副作用。
func (f *fakeUsersDeps) applyUseradd(args []string) error {
	shell := ""
	gecos := ""
	password := "!"
	name := args[len(args)-1]
	for i := 0; i < len(args)-1; i++ {
		switch args[i] {
		case "-s":
			shell = args[i+1]
			i++
		case "-c":
			gecos = args[i+1]
			i++
		case "-p":
			password = args[i+1]
			i++
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, line := range f.passwd {
		if strings.HasPrefix(line, name+":") {
			return fmt.Errorf("useradd: user '%s' already exists", name)
		}
	}
	uid := f.nextUID
	f.nextUID++
	f.passwd = append(f.passwd, fmt.Sprintf("%s:x:%d:%d:%s:/home/%s:%s", name, uid, uid, gecos, name, shell))
	f.shadow = append(f.shadow, fmt.Sprintf("%s:%s:20000:0:99999:7:::", name, password))
	return nil
}

// applyUsermod 模拟 usermod 的账号库副作用。
func (f *fakeUsersDeps) applyUsermod(args []string) error {
	name := args[len(args)-1]
	lock := false
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := 0; i < len(args)-1; i++ {
		switch args[i] {
		case "-c":
			gecos := args[i+1]
			for j, line := range f.passwd {
				if strings.HasPrefix(line, name+":") {
					fields := strings.Split(line, ":")
					fields[4] = gecos
					f.passwd[j] = strings.Join(fields, ":")
				}
			}
			i++
		case "-s":
			shell := args[i+1]
			for j, line := range f.passwd {
				if strings.HasPrefix(line, name+":") {
					fields := strings.Split(line, ":")
					fields[6] = shell
					f.passwd[j] = strings.Join(fields, ":")
				}
			}
			i++
		case "-p":
			hash := args[i+1]
			for j, line := range f.shadow {
				if strings.HasPrefix(line, name+":") {
					fields := strings.Split(line, ":")
					fields[1] = hash
					f.shadow[j] = strings.Join(fields, ":")
				}
			}
			i++
		case "-e":
			expire := args[i+1]
			for j, line := range f.shadow {
				if strings.HasPrefix(line, name+":") {
					fields := strings.Split(line, ":")
					for len(fields) < 8 {
						fields = append(fields, "")
					}
					fields[7] = expire
					f.shadow[j] = strings.Join(fields, ":")
				}
			}
			i++
		case "-L":
			lock = true
		}
	}
	if lock {
		for j, line := range f.shadow {
			if strings.HasPrefix(line, name+":") {
				fields := strings.Split(line, ":")
				if !strings.HasPrefix(fields[1], "!") {
					fields[1] = "!" + fields[1]
				}
				f.shadow[j] = strings.Join(fields, ":")
			}
		}
	}
	return nil
}

// applyUserdel 模拟 userdel 的账号库副作用（不带 -r）。
func (f *fakeUsersDeps) applyUserdel(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	passwd := []string{}
	for _, line := range f.passwd {
		if !strings.HasPrefix(line, name+":") {
			passwd = append(passwd, line)
		}
	}
	shadow := []string{}
	for _, line := range f.shadow {
		if !strings.HasPrefix(line, name+":") {
			shadow = append(shadow, line)
		}
	}
	f.passwd = passwd
	f.shadow = shadow
}

// applyGpasswd 模拟 gpasswd -a/-d 的 sudo 组成员变更。
func (f *fakeUsersDeps) applyGpasswd(args []string) error {
	flag, name, group := args[0], args[1], args[2]
	if group != "sudo" {
		return fmt.Errorf("gpasswd: group '%s' does not exist", group)
	}
	fields := strings.Split(f.sudoLine, ":")
	members := []string{}
	for _, member := range strings.Split(fields[3], ",") {
		if member != "" && member != name {
			members = append(members, member)
		}
	}
	if flag == "-a" {
		members = append(members, name)
	} else if flag != "-d" {
		return fmt.Errorf("gpasswd: unknown option %s", flag)
	}
	fields[3] = strings.Join(members, ",")
	f.sudoLine = strings.Join(fields, ":")
	return nil
}

// sudoMembersNow 当前的 sudo 成员集。
func (f *fakeUsersDeps) sudoMembersNow() map[string]bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return ParseGroupMembers(f.sudoLine)
}
