package security

// 系统账号状态的纯推导（parseSystemUsers.ts 的 Go 等价物）：passwd / shadow /
// group（getent 输出）到 HostUser 视图模型的映射。只做解析与推导，不执行任何命令；
// 服务编排（usersService）据此决定写命令，写后回读也走同一套推导——界面永远看到
// 真实状态，而不是命令的乐观假设。

import (
	"strconv"
	"strings"

	"elysian/server/internal/seam"
)

// ManagedUIDMin 面板管理的 uid 下界：普通用户从 1000 起，root 与系统账号不在此列。
const ManagedUIDMin = 1000

// ManagedUIDMax 面板管理的 uid 上界：nobody(65534) 这类保留账号排除在外。
const ManagedUIDMax = 60000

// ShadowRecord getent shadow 的一行（面板消费的字段子集）。
type ShadowRecord struct {
	Name string
	// PasswordHash 密码字段原文：可用哈希、锁定前缀（!）、占位（*）或空。
	PasswordHash string
	// ExpireDays 账号过期日（自 1970-01-01 起的天数）；未设置或负值（不过期）为 nil。
	ExpireDays *int
}

// ParseShadowLine 解析单行 shadow；字段不足或形状不对时返回 nil。
func ParseShadowLine(line string) *ShadowRecord {
	fields := strings.Split(strings.TrimSpace(line), ":")
	if len(fields) < 8 {
		return nil
	}
	name, passwordHash, expireText := fields[0], fields[1], fields[7]
	if name == "" {
		return nil
	}
	var expireDays *int
	if expireText != "" {
		if parsed, err := strconv.Atoi(expireText); err == nil && parsed >= 0 {
			// 负值按 shadow(5) 语义表示不过期，与空字段同样视为「未设置」。
			expireDays = &parsed
		}
	}
	return &ShadowRecord{Name: name, PasswordHash: passwordHash, ExpireDays: expireDays}
}

// ParseGetentShadow 解析 getent shadow 的多行输出，跳过无法辨认的行。
func ParseGetentShadow(output string) []ShadowRecord {
	var records []ShadowRecord
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if record := ParseShadowLine(trimmed); record != nil {
			records = append(records, *record)
		}
	}
	return records
}

// ParseGroupMembers 解析 getent group sudo 的成员集：`sudo:x:27:ubuntu,elysian`
// 的第四字段按逗号切分。
func ParseGroupMembers(output string) map[string]bool {
	members := map[string]bool{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(strings.TrimSpace(line), ":")
		if len(fields) < 4 {
			continue
		}
		for _, member := range strings.Split(fields[3], ",") {
			name := strings.TrimSpace(member)
			if name != "" {
				members[name] = true
			}
		}
	}
	return members
}

// IsManagedUid 是否落在面板可管理的 uid 范围（1000-60000）：root、系统账号与
// nobody 保留账号都不在。
func IsManagedUid(uid int) bool {
	return uid >= ManagedUIDMin && uid <= ManagedUIDMax
}

// IsNoLoginShell 无登录能力的 shell：nologin 与 false 都无法承载交互登录
// （/sbin/nologin 与 /usr/sbin/nologin 同判）。
func IsNoLoginShell(shell string) bool {
	base := shellBaseName(shell)
	return base == "nologin" || base == "false"
}

// PasswordUsable shadow 密码字段是否为可用哈希：空串、裸 `!`、`*` 都不可用，
// `!` 前缀是锁定标记同样不可用（usermod -L 就是在哈希前加 `!`）。
func PasswordUsable(passwordHash string) bool {
	return passwordHash != "" && passwordHash != "!" && passwordHash != "*" && !strings.HasPrefix(passwordHash, "!")
}

// KeyUsable authorized_keys 是否提供可用的密钥路径：有至少一条有效公钥行
// （空行与 # 注释行不算）。
func KeyUsable(authorizedKeysText *string) bool {
	return authorizedKeysText != nil && len(ParseKeyLines(*authorizedKeysText)) > 0
}

// LoginMethodOf 登录方式的诚实推导：shell 为 nologin 时一律 none；否则按
// 「密码可用」与「密钥可用」组合出四档。两者皆无时如实呈现 none——实际没有
// 任何可用方式，不呈现界面请求的样子。
func LoginMethodOf(shell string, passwordHash *string, authorizedKeysText *string) string {
	if IsNoLoginShell(shell) {
		return "none"
	}
	byPassword := passwordHash != nil && PasswordUsable(*passwordHash)
	byKey := KeyUsable(authorizedKeysText)
	if byPassword && byKey {
		return "password-or-key"
	}
	if byPassword {
		return "password"
	}
	if byKey {
		return "key"
	}
	return "none"
}

// StatusOf 账号状态推导：sp_expire 已设置且不晚于今天即 disabled——账号过期挡一切
// 登录，无论登录方式为何。其余（含未设置过期）为 active。
func StatusOf(expireDays *int, nowIso string) string {
	if expireDays == nil {
		return "active"
	}
	if *expireDays <= daysSinceEpochUtc(nowIso) {
		return "disabled"
	}
	return "active"
}

// NoteOfGecos 备注取 passwd 第 5 字段（GECOS 全文）trim 后的值，空为 null。
// 写侧用 useradd/usermod -c <备注> 落的就是这一字段，读写同一口径才能回读一致。
func NoteOfGecos(gecos string) *string {
	note := strings.TrimSpace(gecos)
	if note == "" {
		return nil
	}
	return &note
}

// HostUserDeriveState 把单个账号的各源数据推导成 HostUser 视图的输入。
type HostUserDeriveState struct {
	Passwd             seam.PasswdRecord
	Shadow             *ShadowRecord
	SudoMembers        map[string]bool
	AuthorizedKeysText *string
	NowIso             string
}

// DeriveHostUser 把单个账号的各源数据推导成 HostUser 视图。/etc/passwd 不记录
// 账号创建时间、容器 overlayfs 的 btime 不可靠，CreatedAt 恒为 null。
func DeriveHostUser(state HostUserDeriveState) HostUser {
	var passwordHash *string
	if state.Shadow != nil {
		passwordHash = &state.Shadow.PasswordHash
	}
	return HostUser{
		ID:          state.Passwd.Name,
		Name:        state.Passwd.Name,
		IsAdmin:     state.SudoMembers[state.Passwd.Name],
		LoginMethod: LoginMethodOf(state.Passwd.Shell, passwordHash, state.AuthorizedKeysText),
		Status:      StatusOf(shadowExpireOf(state.Shadow), state.NowIso),
		Note:        NoteOfGecos(state.Passwd.Gecos),
		CreatedAt:   nil,
	}
}

// shadowExpireOf 取 shadow 的过期日（无 shadow 为 nil）。
func shadowExpireOf(shadow *ShadowRecord) *int {
	if shadow == nil {
		return nil
	}
	return shadow.ExpireDays
}

// ParseGetentPasswd 解析 getent passwd 多行输出为跨域记录（files 域经
// seam.SystemAccounts 消费同一形状）。
func ParseGetentPasswd(output string) []seam.PasswdRecord {
	var records []seam.PasswdRecord
	for _, entry := range ParseGetentPasswdRecords(output) {
		records = append(records, seam.PasswdRecord{
			Name:  entry.Name,
			UID:   entry.UID,
			GID:   entry.GID,
			Gecos: entry.Gecos,
			Home:  entry.Home,
			Shell: entry.Shell,
		})
	}
	return records
}

// PasswdRecord getent passwd 的一行（含 GECOS，users 域消费）。
type PasswdRecord = seam.PasswdRecord

// ParseGetentPasswdRecords 解析 getent passwd 多行输出（含 GECOS 字段），跳过
// 无法辨认的行。
func ParseGetentPasswdRecords(output string) []PasswdRecord {
	var records []PasswdRecord
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if record := parsePasswdRecordLine(trimmed); record != nil {
			records = append(records, *record)
		}
	}
	return records
}

// parsePasswdRecordLine 解析单行 passwd（含 GECOS）；字段不足或 uid/gid 非数字时
// 返回 nil。
func parsePasswdRecordLine(line string) *PasswdRecord {
	fields := strings.Split(strings.TrimSpace(line), ":")
	if len(fields) < 7 {
		return nil
	}
	name, uidText, gidText, gecos, home, shell := fields[0], fields[2], fields[3], fields[4], fields[5], fields[6]
	if !isAllDigits(uidText) || !isAllDigits(gidText) {
		return nil
	}
	uid, errUID := strconv.Atoi(uidText)
	gid, errGID := strconv.Atoi(gidText)
	if errUID != nil || errGID != nil {
		return nil
	}
	if name == "" || home == "" || shell == "" {
		return nil
	}
	return &PasswdRecord{Name: name, UID: uid, GID: gid, Gecos: gecos, Home: home, Shell: shell}
}
