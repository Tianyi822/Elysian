package security

// 用户管理的服务编排（usersService.ts 的 Go 等价物）：把界面动作翻译成容器内
// useradd/usermod/userdel/gpasswd/chpasswd 的真实执行。全部系统访问经 deps 注入，
// 编排逻辑在 go test 里用有状态 fake（内存 passwd/shadow/group 与命令账本）驱动。
//
// 安全红线：
//   - 命令全部数组传参执行，绝不拼 shell 字符串，也绝不手改 /etc/passwd、
//     /etc/shadow 或 /etc/group——命令自带文件锁与原子写。
//   - 密码只走 chpasswd 的 stdin（`账号:密码`），绝不进命令行；换行与控制字符拒绝。
//   - 用户名与备注双侧同判据：用户名复用 IsValidHostUserName，备注复用控制字符
//     判据并额外拒逗号（GECOS 里逗号用于分字段）。
//   - 保护边界：目标账号服务端反查，root 与 uid 越出 1000-60000 的账号即使被伪造
//     请求点名也拒绝，且不执行任何写命令。
//   - 最后一个 sudo 成员防呆：降级或删除前解析 getent group sudo 的当前成员，
//     目标是仅剩成员时拒绝——绝不让容器里清空全部可提权账号。
//   - 每次写操作完成后回读该账号（passwd/shadow/group/authorized_keys 重新推导），
//     绝不返回未经回读的乐观值。

import (
	"fmt"
	"sort"
	"strings"

	"elysian/server/internal/shared"
)

// NOLOGIN_SHELL 停用登录的 shell：method 为 none 时用它挡住交互登录。
const NOLOGIN_SHELL = "/sbin/nologin"

// LOGIN_SHELL 允许登录的 shell：其余登录方式统一落 /bin/bash。
const LOGIN_SHELL = "/bin/bash"

// HostUserInput 新建或修改账号的输入（用户名只在创建时确定）。
type HostUserInput struct {
	LoginMethod string
	Status      string
	IsAdmin     bool
	Note        *string
	// Password 初始或新密码：nil 表示本次不动密码；登录方式含密码时创建必填。
	Password *string
}

// usersAPI 路由层消费的服务面。
type usersAPI interface {
	List() ([]HostUser, error)
	Create(name string, input HostUserInput) (HostUser, error)
	Update(userId string, input HostUserInput) (HostUser, error)
	Remove(userId string) error
	SyncFromSystem() (int, error)
}

// usersService 服务实现。
type usersService struct {
	deps *usersHostDeps
}

// newUsersService 构造服务。
func newUsersService(deps *usersHostDeps) *usersService {
	return &usersService{deps: deps}
}

// methodIncludesPassword 登录方式是否包含密码路径。
func methodIncludesPassword(method string) bool {
	return method == "password" || method == "password-or-key"
}

// commandError 命令失败的统一包装。
func (s *usersService) commandError(command string, args []string, err error) error {
	full := append([]string{command}, args...)
	return fmt.Errorf("%s 执行失败（%s）：%v", command, strings.Join(full, " "), err)
}

// assertNoteSafe 备注双侧判据：控制字符对照统一禁区，逗号是 GECOS 的字段分隔符。
func assertNoteSafe(note *string) error {
	if note != nil && *note != "" {
		if hasUnsafeControlChars(*note) {
			return shared.InvalidRequest("备注不能包含换行或控制字符")
		}
		if strings.Contains(*note, ",") {
			return shared.InvalidRequest("备注不能包含逗号（GECOS 里逗号用于分字段）")
		}
	}
	return nil
}

// assertPasswordSafe 密码双侧判据：换行/控制字符拒绝（chpasswd 按行解析），强度弱拒绝。
func assertPasswordSafe(password string) error {
	if hasUnsafeControlChars(password) {
		return shared.InvalidRequest("密码不能包含换行或控制字符")
	}
	if EvaluateSshPasswordStrength(password) == "weak" {
		return shared.InvalidRequest("密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号")
	}
	return nil
}

// resolvePassword 校验密码输入与登录方式的一致性：含密码的登录方式必须提供密码
// （创建时），不含密码的登录方式不允许夹带密码。返回归一后的密码（nil 表示本次
// 不动密码）。
func resolvePassword(input HostUserInput, required bool) (*string, error) {
	if input.Password != nil && *input.Password != "" {
		if !methodIncludesPassword(input.LoginMethod) {
			return nil, shared.InvalidRequest("登录方式不含密码时不能设置密码")
		}
		if err := assertPasswordSafe(*input.Password); err != nil {
			return nil, err
		}
		return input.Password, nil
	}
	if required && methodIncludesPassword(input.LoginMethod) {
		return nil, shared.InvalidRequest("登录方式含密码时必须填写初始密码")
	}
	return nil, nil
}

// passwdRecords 全量 passwd 记录。
func (s *usersService) passwdRecords() ([]PasswdRecord, error) {
	output, err := s.deps.runGetent([]string{"passwd"})
	if err != nil {
		return nil, s.commandError("getent", []string{"passwd"}, err)
	}
	return ParseGetentPasswdRecords(output), nil
}

// findPasswd 按名反查 passwd 记录；查无结果为 nil。
func (s *usersService) findPasswd(name string) (*PasswdRecord, error) {
	output, err := s.deps.runGetent([]string{"passwd", name})
	if err != nil {
		return nil, s.commandError("getent", []string{"passwd", name}, err)
	}
	records := ParseGetentPasswdRecords(output)
	if len(records) == 0 {
		return nil, nil
	}
	return &records[0], nil
}

// shadowOf 单个账号的 shadow 记录；查无结果为 nil。
func (s *usersService) shadowOf(name string) (*ShadowRecord, error) {
	output, err := s.deps.runGetent([]string{"shadow", name})
	if err != nil {
		return nil, s.commandError("getent", []string{"shadow", name}, err)
	}
	records := ParseGetentShadow(output)
	if len(records) == 0 {
		return nil, nil
	}
	return &records[0], nil
}

// sudoMembers getent group sudo 的当前成员集。
func (s *usersService) sudoMembers() (map[string]bool, error) {
	output, err := s.deps.runGetent([]string{"group", "sudo"})
	if err != nil {
		return nil, s.commandError("getent", []string{"group", "sudo"}, err)
	}
	return ParseGroupMembers(output), nil
}

// authorizedKeysText 账号的 authorized_keys 内容：主目录只从 getent 推导，读不到
// （无文件）为 nil。
func (s *usersService) authorizedKeysText(entry PasswdRecord) *string {
	path := authorizedKeysPath(entry.Home)
	if !s.deps.exists(path) {
		return nil
	}
	text, err := s.deps.readText(path)
	if err != nil {
		return nil
	}
	return &text
}

// readUser 回读单个账号并推导成视图模型；读不到时抛中文错误。
func (s *usersService) readUser(name string) (HostUser, error) {
	entry, err := s.findPasswd(name)
	if err != nil {
		return HostUser{}, err
	}
	if entry == nil {
		return HostUser{}, shared.InvalidRequest(fmt.Sprintf("未找到系统账号：%s", name))
	}
	shadow, err := s.shadowOf(name)
	if err != nil {
		return HostUser{}, err
	}
	sudo, err := s.sudoMembers()
	if err != nil {
		return HostUser{}, err
	}
	return DeriveHostUser(HostUserDeriveState{
		Passwd:             *entry,
		Shadow:             shadow,
		SudoMembers:        sudo,
		AuthorizedKeysText: s.authorizedKeysText(*entry),
		NowIso:             s.deps.nowIso(),
	}), nil
}

// manageablePasswd 保护边界：按 userId 反查系统账号，反查不到或 uid 越出
// 1000-60000（含 root）一律拒绝。返回反查到的账号条目供后续编排使用；任何写
// 命令都在这之后才会执行。
func (s *usersService) manageablePasswd(userId string) (*PasswdRecord, error) {
	entry, err := s.findPasswd(userId)
	if err != nil {
		return nil, err
	}
	if entry == nil {
		return nil, shared.InvalidRequest(fmt.Sprintf("未找到系统账号：%s", userId))
	}
	if entry.Name == "root" || entry.UID < ManagedUIDMin || entry.UID > ManagedUIDMax {
		return nil, shared.InvalidRequest(fmt.Sprintf(
			"拒绝操作系统账号：%s（仅管理 uid %d-%d 的账号）", userId, ManagedUIDMin, ManagedUIDMax,
		))
	}
	return entry, nil
}

// assertNotLastSudoMember 最后一个 sudo 成员防呆：降级或删除仅剩的管理员会让容器
// 内再无任何可提权账号，面板自己也会被锁在门外——目标是仅剩成员时直接拒绝，
// 且不执行任何写命令。
func assertNotLastSudoMember(name string, sudo map[string]bool, action string) error {
	if sudo[name] && len(sudo) <= 1 {
		return shared.InvalidRequest(fmt.Sprintf(
			"拒绝%s %s：它是 sudo 组最后一个成员，操作后容器内将没有任何可提权账号", action, name,
		))
	}
	return nil
}

// List 账号列表：只含 uid 1000-60000 的系统账号，按名字升序。
func (s *usersService) List() ([]HostUser, error) {
	entries, err := s.passwdRecords()
	if err != nil {
		return nil, err
	}
	managed := []PasswdRecord{}
	for _, entry := range entries {
		if IsManagedUid(entry.UID) {
			managed = append(managed, entry)
		}
	}
	shadowOutput, err := s.deps.runGetent([]string{"shadow"})
	if err != nil {
		return nil, s.commandError("getent", []string{"shadow"}, err)
	}
	sudo, err := s.sudoMembers()
	if err != nil {
		return nil, err
	}
	shadowByName := map[string]ShadowRecord{}
	for _, record := range ParseGetentShadow(shadowOutput) {
		shadowByName[record.Name] = record
	}
	users := []HostUser{}
	for _, entry := range managed {
		var shadow *ShadowRecord
		if record, ok := shadowByName[entry.Name]; ok {
			shadow = &record
		}
		users = append(users, DeriveHostUser(HostUserDeriveState{
			Passwd:             entry,
			Shadow:             shadow,
			SudoMembers:        sudo,
			AuthorizedKeysText: s.authorizedKeysText(entry),
			NowIso:             s.deps.nowIso(),
		}))
	}
	// 创建时间恒为 null（无从取材），倒序无从谈起；按名字升序返回，排序口径稳定可解释。
	sort.SliceStable(users, func(i, j int) bool { return users[i].Name < users[j].Name })
	return users, nil
}

// Create 创建账号：用户名按 Linux 取名规则校验且系统不存在（getent passwd 反查为空）；
// 命令序列 useradd →（isAdmin 时）gpasswd -a →（有密码时）chpasswd →（disabled 时）
// usermod -e 1 -L；完成后回读真实状态。
func (s *usersService) Create(name string, input HostUserInput) (HostUser, error) {
	// 用户名判据与表单共用同一函数：界面挡一次，这里再挡一次，绕过界面也建不出账号。
	if !IsValidHostUserName(name) {
		return HostUser{}, shared.InvalidRequest("用户名只能用小写字母、数字、下划线与连字符，且由字母或下划线开头")
	}
	existing, err := s.findPasswd(name)
	if err != nil {
		return HostUser{}, err
	}
	if existing != nil {
		return HostUser{}, shared.InvalidRequest(fmt.Sprintf("用户名已存在：%s", name))
	}
	if err := assertNoteSafe(input.Note); err != nil {
		return HostUser{}, err
	}
	// 创建时登录方式含密码则初始密码必填；密码绝不进命令行，只走 chpasswd 的 stdin。
	password, err := resolvePassword(input, true)
	if err != nil {
		return HostUser{}, err
	}

	shell := LOGIN_SHELL
	if input.LoginMethod == "none" {
		shell = NOLOGIN_SHELL
	}
	useraddArgs := []string{"-m", "-s", shell}
	if password == nil {
		// 无密码创建用 -p '*'（无可用密码、不锁账号）：不带 -p 的 shadow 是裸 '!'，
		// sshd(UsePAM) 对锁定账号连公钥认证都拒绝——「只能密钥登录」的账号第一次用
		// 密钥就会被打回密码提示。
		useraddArgs = append(useraddArgs, "-p", "*")
	}
	if input.Note != nil && *input.Note != "" {
		// 备注为空时省 -c：GECOS 留空，回读推导为 null。
		useraddArgs = append(useraddArgs, "-c", *input.Note)
	}
	useraddArgs = append(useraddArgs, name)
	if _, err := s.deps.runUseradd(useraddArgs); err != nil {
		return HostUser{}, s.commandError("useradd", useraddArgs, err)
	}

	if input.IsAdmin {
		args := []string{"-a", name, "sudo"}
		if _, err := s.deps.runGpasswd(args); err != nil {
			return HostUser{}, s.commandError("gpasswd", args, err)
		}
	}

	if password != nil {
		if _, err := s.deps.runChpasswd(name + ":" + *password); err != nil {
			// 错误信息只描述命令本身：密码绝不进命令行，也不进任何日志与报错。
			return HostUser{}, fmt.Errorf("chpasswd 执行失败：%v", err)
		}
	}

	if input.Status == "disabled" {
		args := []string{"-e", "1", "-L", name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	}

	// 回读真实状态：绝不返回命令拼出来的乐观值。
	return s.readUser(name)
}

// Update 修改账号：只改认证方式、状态、管理员归属与备注，用户名不动。判定与当前
// 状态 diff 后执行；降级仅剩管理员先于一切写命令拒绝；恢复密码登录的红线——当前
// 没有可用密码（'!' 锁定或 '*' 占位）且未提供新密码时拒绝保存。
func (s *usersService) Update(userId string, input HostUserInput) (HostUser, error) {
	entry, err := s.manageablePasswd(userId)
	if err != nil {
		return HostUser{}, err
	}
	if err := assertNoteSafe(input.Note); err != nil {
		return HostUser{}, err
	}
	password, err := resolvePassword(input, false)
	if err != nil {
		return HostUser{}, err
	}
	shadow, err := s.shadowOf(entry.Name)
	if err != nil {
		return HostUser{}, err
	}
	sudo, err := s.sudoMembers()
	if err != nil {
		return HostUser{}, err
	}
	currentNote := NoteOfGecos(entry.Gecos)
	currentIsAdmin := sudo[entry.Name]
	// 降级仅剩的管理员先于一切写命令拒绝：不让备注、shell 等无关变更先落盘。
	if !input.IsAdmin && currentIsAdmin {
		if err := assertNotLastSudoMember(entry.Name, sudo, "降级"); err != nil {
			return HostUser{}, err
		}
	}

	// 恢复密码登录的红线：当前没有可用密码且未提供新密码时拒绝保存——'!' 与 '*'
	// 都没有明文可解，绝不假装恢复；要启用密码登录必须换新密码。
	if methodIncludesPassword(input.LoginMethod) && password == nil {
		hash := ""
		if shadow != nil {
			hash = shadow.PasswordHash
		}
		if !PasswordUsable(hash) {
			return HostUser{}, shared.InvalidRequest("当前未设置可用密码，请填写新密码后再启用密码登录")
		}
	}

	noteChanged := (currentNote == nil) != (input.Note == nil) ||
		(currentNote != nil && input.Note != nil && *currentNote != *input.Note)
	if noteChanged {
		// note 为 null 时传空串：usermod -c '' 即清空 GECOS。
		noteValue := ""
		if input.Note != nil {
			noteValue = *input.Note
		}
		args := []string{"-c", noteValue, entry.Name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	}

	if input.IsAdmin != currentIsAdmin {
		flag := "-d"
		if input.IsAdmin {
			flag = "-a"
		}
		args := []string{flag, entry.Name, "sudo"}
		if _, err := s.deps.runGpasswd(args); err != nil {
			return HostUser{}, s.commandError("gpasswd", args, err)
		}
	}

	// 登录方式落到 shell：none 用 /sbin/nologin，其余统一 /bin/bash；与当前不同才执行。
	targetShell := LOGIN_SHELL
	if input.LoginMethod == "none" {
		targetShell = NOLOGIN_SHELL
	}
	if entry.Shell != targetShell {
		args := []string{"-s", targetShell, entry.Name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	}

	if password != nil {
		if _, err := s.deps.runChpasswd(entry.Name + ":" + *password); err != nil {
			return HostUser{}, fmt.Errorf("chpasswd 执行失败：%v", err)
		}
	}

	// 登录方式从含密码改为不含密码：旧密码作废用 -p '*'，而不是 -L——
	// -L 在哈希前加 '!' 会锁定整个账号，sshd(UsePAM) 对锁定账号连公钥认证都拒绝。
	currentMethodIncludesPassword := shadow != nil && !IsNoLoginShell(entry.Shell) && PasswordUsable(shadow.PasswordHash)
	if currentMethodIncludesPassword && !methodIncludesPassword(input.LoginMethod) {
		args := []string{"-p", "*", entry.Name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	}

	// 登录方式不含密钥（仅密码）：把该账号的 authorized_keys 真正移除——留着的公钥行
	// 仍能登录，面板呈现的「仅密码」就是假状态。none 由 nologin shell 挡住一切登录，
	// 不动密钥文件。
	if input.LoginMethod == "password" {
		keysPath := authorizedKeysPath(entry.Home)
		if s.deps.exists(keysPath) {
			if err := s.deps.remove(keysPath); err != nil {
				return HostUser{}, s.commandError("unlink", []string{keysPath}, err)
			}
		}
	}

	// 状态：停用即设过期日并锁密码（账号过期挡一切登录）；恢复只清过期日（-e ''）。
	if input.Status == "disabled" {
		args := []string{"-e", "1", "-L", entry.Name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	} else if shadow != nil && shadow.ExpireDays != nil && *shadow.ExpireDays <= daysSinceEpochUtc(s.deps.nowIso()) {
		args := []string{"-e", "", entry.Name}
		if _, err := s.deps.runUsermod(args); err != nil {
			return HostUser{}, s.commandError("usermod", args, err)
		}
	}

	return s.readUser(entry.Name)
}

// Remove 删除账号：绝不带 -r（主目录保留，数据不随账号一起销毁）；回读确认不存在；
// 凭据随账号销毁——userdel 不动主目录，残留的 authorized_keys（含面板写入的 .bak）
// 会在同名重建时被新账号继承（useradd 复用释放的 uid，属主恰好吻合，旧私钥即可
// 直接登录新账号）。
func (s *usersService) Remove(userId string) error {
	entry, err := s.manageablePasswd(userId)
	if err != nil {
		return err
	}
	sudo, err := s.sudoMembers()
	if err != nil {
		return err
	}
	if err := assertNotLastSudoMember(entry.Name, sudo, "删除"); err != nil {
		return err
	}
	args := []string{entry.Name}
	if _, err := s.deps.runUserdel(args); err != nil {
		return s.commandError("userdel", args, err)
	}
	// 回读确认：userdel 之后系统里不该再有这个账号，仍查得到即如实报错。
	still, err := s.findPasswd(entry.Name)
	if err != nil {
		return err
	}
	if still != nil {
		return fmt.Errorf("删除未生效：系统里仍存在账号 %s", entry.Name)
	}

	keysPath := authorizedKeysPath(entry.Home)
	for _, path := range []string{keysPath, keysPath + ".bak"} {
		if !s.deps.exists(path) {
			continue
		}
		if err := s.deps.remove(path); err != nil {
			return s.commandError("unlink", []string{path}, err)
		}
	}
	return nil
}

// SyncFromSystem 从承载本页签的操作系统重新读取账号列表：同步即重读（list 走的
// 就是 getent 的真实读路径）。
func (s *usersService) SyncFromSystem() (int, error) {
	users, err := s.List()
	if err != nil {
		return 0, err
	}
	return len(users), nil
}
