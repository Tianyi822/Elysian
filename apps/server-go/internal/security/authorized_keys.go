package security

// authorized_keys 的定位与行级编辑（shared/authorizedKeys.ts 的 Go 等价物）：
// 路径只从服务端的 getent passwd 推导，绝不接受客户端传来的路径；行级增删按
// 「整行精确匹配」进行，公钥行经 ssh-keygen -lf 验证合法后才落盘（验证由
// sshHostDeps 的 runSshKeygen 执行，这里只负责纯文本部分与 -lf 输出的解析）。

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// PasswdEntry getent passwd 的一行（密钥管理视角）：name:passwd:uid:gid:gecos:home:shell。
type PasswdEntry struct {
	Name  string
	UID   int
	GID   int
	Home  string
	Shell string
}

// ParsePasswdLine 解析单行；字段不足或 uid/gid 非数字时返回 nil。
func ParsePasswdLine(line string) *PasswdEntry {
	fields := strings.Split(strings.TrimSpace(line), ":")
	if len(fields) < 7 {
		return nil
	}
	name, uidText, gidText, home, shell := fields[0], fields[2], fields[3], fields[5], fields[6]
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
	return &PasswdEntry{Name: name, UID: uid, GID: gid, Home: home, Shell: shell}
}

// ParseGetentPasswdEntries 解析 getent passwd 的多行输出，跳过无法辨认的行。
func ParseGetentPasswdEntries(output string) []PasswdEntry {
	var entries []PasswdEntry
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if entry := ParsePasswdLine(trimmed); entry != nil {
			entries = append(entries, *entry)
		}
	}
	return entries
}

// isLoginShell 无登录能力的 shell：nologin 与 false 都无法承载交互登录。
func isLoginShell(shell string) bool {
	base := shellBaseName(shell)
	return base != "nologin" && base != "false"
}

// IsKeyAccount 账号是否可归属密钥：uid≥1000 且有登录 shell，root 除外——
// Root 的密钥由 Root 密钥卡单独管理，不混进登录密钥的归属清单。
func IsKeyAccount(entry PasswdEntry) bool {
	return entry.Name != "root" && entry.UID >= 1000 && isLoginShell(entry.Shell)
}

// ListKeyAccounts 密钥可归属的真实系统账号清单（见 IsKeyAccount）。
func ListKeyAccounts(passwdOutput string) []SshKeyAccount {
	var accounts []SshKeyAccount
	for _, entry := range ParseGetentPasswdEntries(passwdOutput) {
		if IsKeyAccount(entry) {
			accounts = append(accounts, SshKeyAccount{ID: entry.Name, Name: entry.Name})
		}
	}
	return accounts
}

// sshDirPath 账号主目录下的 .ssh 目录路径；只由服务端拼接，客户端无从注入。
func sshDirPath(homeDir string) string {
	return strings.TrimRight(homeDir, "/") + "/.ssh"
}

// authorizedKeysPath 账号的 authorized_keys 路径；同样只由服务端拼接。
func authorizedKeysPath(homeDir string) string {
	return sshDirPath(homeDir) + "/authorized_keys"
}

// ParseKeyLines 读出有效公钥行：去掉空行与 # 注释行，保留原文行（trim 后）。
func ParseKeyLines(text string) []string {
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

// AppendKeyLine 追加一行公钥：文件无结尾换行时补上，保证每行恰是一条公钥。
func AppendKeyLine(text string, keyLine string) string {
	trimmed := strings.TrimRightFunc(text, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' || r == 0x85 || r == 0xa0
	})
	if trimmed == "" {
		return keyLine + "\n"
	}
	return trimmed + "\n" + keyLine + "\n"
}

// RemoveKeyLine 按整行精确匹配移除一条公钥；行不存在时原样返回，由调用方决定是否报错。
func RemoveKeyLine(text string, keyLine string) string {
	lines := strings.Split(text, "\n")
	index := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == keyLine {
			index = i
			break
		}
	}
	if index < 0 {
		return text
	}
	return strings.Join(append(lines[:index:index], lines[index+1:]...), "\n")
}

// ReplaceFirstKeyLine 替换文件里的第一条公钥行（Root 密钥卡只管理 root
// authorized_keys 的首行，其余行原样保留）；文件里还没有任何公钥行时，
// 整份文件只剩新行。
func ReplaceFirstKeyLine(text string, keyLine string) string {
	lines := strings.Split(text, "\n")
	index := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			index = i
			break
		}
	}
	if index < 0 {
		return keyLine + "\n"
	}
	lines[index] = keyLine
	return strings.Join(lines, "\n")
}

// fnv1a FNV-1a 32 位：给公钥行派生稳定 id 的确定性哈希（非安全用途，只求跨读取
// 稳定）。按 UTF-16 码元迭代（与 TS charCodeAt 语义一致：BMP 内字符两实现相同，
// 增补平面字符经代理对参与哈希），Math.imul 加 >>>0 即 32 位回绕乘法。
func fnv1a(text string) string {
	hash := uint32(0x811c9dc5)
	for _, unit := range utf16.Encode([]rune(text)) {
		hash ^= uint32(unit)
		hash *= 0x01000193
	}
	return fmt.Sprintf("%08x", hash)
}

// KeyLineId 公钥行的稳定标识：同一行永远同一 id，删除按 id 反查整行。
func KeyLineId(keyLine string) string {
	return "sshkey-" + fnv1a(strings.TrimSpace(keyLine))
}

// AuthorizedKeyId 账号维度的授权行 id：账号名参与哈希，同一公钥行装进多个账号时
// id 各不相同。删除按 id 反查只会撤销目标账号的那一行，不会误删其他账号的同款公钥。
func AuthorizedKeyId(account string, keyLine string) string {
	return "sshkey-" + fnv1a(account+"\n"+strings.TrimSpace(keyLine))
}

// KeyCommentOf 公钥行的注释段（第三段起）：面板用它当密钥名，本面板创建的行
// 注释形如 elysian-<名称>。
func KeyCommentOf(keyLine string) string {
	fields := strings.Fields(strings.TrimSpace(keyLine))
	if len(fields) >= 3 {
		return strings.Join(fields[2:], " ")
	}
	return ""
}

// KeygenFingerprint ssh-keygen -lf 的输出：`256 SHA256:xxxx elysian-部署机 (ED25519)`。
type KeygenFingerprint struct {
	Bits        int
	Fingerprint string
	Comment     string
	// TypeToken 括号里的算法短名，如 ED25519。
	TypeToken string
}

// keygenFingerprintRe -lf 输出行的形状。
var keygenFingerprintRe = regexp.MustCompile(`^(\d+)\s+(SHA256:\S+)\s+(.*?)\s*\((\w+)\)\s*$`)

// ParseKeygenFingerprint 解析 -lf 输出行；形状不对返回 nil。
func ParseKeygenFingerprint(stdout string) *KeygenFingerprint {
	firstLine := stdout
	if idx := strings.IndexByte(stdout, '\n'); idx >= 0 {
		firstLine = stdout[:idx]
	}
	match := keygenFingerprintRe.FindStringSubmatch(strings.TrimSpace(firstLine))
	if match == nil {
		return nil
	}
	bits, err := strconv.Atoi(match[1])
	if err != nil {
		return nil
	}
	return &KeygenFingerprint{Bits: bits, Fingerprint: match[2], Comment: match[3], TypeToken: match[4]}
}

// typeTokenNames -lf 括号短名 → 公钥类型名（与 authorized_keys 首段同词）。
var typeTokenNames = map[string]string{
	"ED25519": "ssh-ed25519",
	"RSA":     "ssh-rsa",
	"ECDSA":   "ecdsa-sha2-nistp256",
	"DSA":     "ssh-dss",
}

// AlgorithmLabelOf 密钥算法的呈现文本，如 `ssh-ed25519 256`；未知短名原样保留。
func AlgorithmLabelOf(fingerprint KeygenFingerprint) string {
	typeName, ok := typeTokenNames[fingerprint.TypeToken]
	if !ok {
		typeName = fingerprint.TypeToken
	}
	return typeName + " " + strconv.Itoa(fingerprint.Bits)
}

// shellBaseName shell 路径的最后一段（"/sbin/nologin" → "nologin"）。
func shellBaseName(shell string) string {
	if idx := strings.LastIndexByte(shell, '/'); idx >= 0 {
		return shell[idx+1:]
	}
	return shell
}
