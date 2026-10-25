package auth

import (
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"elysian/server/internal/config"
	"elysian/server/internal/paths"
)

// 面板登录凭据（单用户 admin）：~/.Elysian/config/panel-credentials.json（credentialsStore.ts
// 等价物）。Current 每次直读文件、不缓存（设计决定，放弃 mtime 缓存）：直读让 CLI 改密
// 落盘后 server 下一次请求必然看到新 passwordChangedAt，既有会话随之全量失效，无任何
// 时间窗口。解析失败（坏 JSON、缺字段、版本不符、权限被放宽）一律回 nil——fail closed：
// 登录恒拒绝、既有会话恒失效。

// PanelCredentials 面板凭据。PasswordChangedAt 是 ISO 时间串，会话失效的 epoch 基准。
type PanelCredentials struct {
	Username          string `json:"username"`
	PasswordHash      string `json:"passwordHash"`
	PasswordChangedAt string `json:"passwordChangedAt"`
}

// CredentialsStore 凭据存取接口。
type CredentialsStore interface {
	// Current 读当前凭据；文件缺失或不可信回 nil。每次调用直读文件并解析，不做任何缓存。
	// 仅当打开失败且不属于 fail-closed 集合（ENOENT/ELOOP 之外，如 EACCES）才返回 error。
	Current() (*PanelCredentials, error)
	// Write 原子写入新哈希并返回含新 passwordChangedAt 的完整凭据。
	Write(passwordHash string) (*PanelCredentials, error)
}

// credentialsFile 落盘形状：键序即 JSON 输出序（version 恒在首位，对齐 TS
// JSON.stringify({ version: 1, ...credentials })）。
type credentialsFile struct {
	Version           int    `json:"version"`
	Username          string `json:"username"`
	PasswordHash      string `json:"passwordHash"`
	PasswordChangedAt string `json:"passwordChangedAt"`
}

// NewFileCredentialsStore 构造文件版凭据 store（path 传空串时用 ~/.Elysian 缺省路径）。
func NewFileCredentialsStore(path string) CredentialsStore {
	if path == "" {
		path = paths.Default.PanelCredentials
	}
	return &fileCredentialsStore{path: path}
}

type fileCredentialsStore struct {
	path string
}

// lockFirstBoot serializes first-boot checks across separate panel processes.
func (s *fileCredentialsStore) lockFirstBoot() (func(), error) {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(s.path+".init.lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if !statTrustedFile(file, 0) {
		_ = file.Close()
		return nil, fmt.Errorf("首启凭据锁文件不可信")
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if err != syscall.EINTR {
			_ = file.Close()
			return nil, err
		}
	}
}

func (s *fileCredentialsStore) credentialFileExists() (bool, error) {
	_, err := os.Lstat(s.path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func statTrustedFile(file *os.File, maxBytes int64) bool {
	info, err := file.Stat()
	return err == nil && statTrusted(info, maxBytes)
}

// parseCredentials 判定解析出的 JSON 是否是合法凭据；版本与三字段缺一不可。
func parseCredentialsFile(data []byte) (*PanelCredentials, bool) {
	var file credentialsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, false
	}
	if file.Version != 1 || file.Username == "" || file.PasswordHash == "" || file.PasswordChangedAt == "" {
		return nil, false
	}
	return &PanelCredentials{
		Username:          file.Username,
		PasswordHash:      file.PasswordHash,
		PasswordChangedAt: file.PasswordChangedAt,
	}, true
}

// Current 实现 CredentialsStore。
func (s *fileCredentialsStore) Current() (*PanelCredentials, error) {
	file, err := openNoFollow(s.path)
	if err != nil {
		// 文件不存在与最终组件是符号链接（O_NOFOLLOW 拒绝）都视为「凭据不可用」。
		if isNoFollowMiss(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()
	fi, err := file.Stat()
	if err != nil {
		return nil, nil
	}
	if !statTrusted(fi, credentialsMaxBytes) {
		return nil, nil
	}
	data, err := io.ReadAll(file)
	if err != nil {
		// 坏 JSON、读失败：fail closed，不向调用方抛（登录/会话判定按「无凭据」处理）。
		return nil, nil
	}
	if credentials, ok := parseCredentialsFile(data); ok {
		return credentials, nil
	}
	return nil, nil
}

// Write 实现 CredentialsStore：0600 临时文件 + fsync + rename 原子替换。
func (s *fileCredentialsStore) Write(passwordHash string) (*PanelCredentials, error) {
	credentials := PanelCredentials{
		Username:          PanelUsername,
		PasswordHash:      passwordHash,
		PasswordChangedAt: isoNowMillis(),
	}
	data, err := json.MarshalIndent(credentialsFile{
		Version:           1,
		Username:          credentials.Username,
		PasswordHash:      credentials.PasswordHash,
		PasswordChangedAt: credentials.PasswordChangedAt,
	}, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(s.path, data); err != nil {
		return nil, err
	}
	return &credentials, nil
}

// NewMemoryCredentialsStore 构造内存版凭据 store（测试用，不碰文件系统）。
// initial 为 nil 时缺省为空；Current 回深拷贝（外部改动不影响内部）。
func NewMemoryCredentialsStore(initial *PanelCredentials) CredentialsStore {
	store := &memoryCredentialsStore{}
	if initial != nil {
		current := *initial
		store.current = &current
	}
	return store
}

type memoryCredentialsStore struct {
	mu      sync.Mutex
	current *PanelCredentials
}

// Current 实现 CredentialsStore。
func (s *memoryCredentialsStore) Current() (*PanelCredentials, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == nil {
		return nil, nil
	}
	copied := *s.current
	return &copied, nil
}

// Write 实现 CredentialsStore：推进 passwordChangedAt（真实时钟，与 TS 内存版一致）。
func (s *memoryCredentialsStore) Write(passwordHash string) (*PanelCredentials, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	written := PanelCredentials{
		Username:          PanelUsername,
		PasswordHash:      passwordHash,
		PasswordChangedAt: isoNowMillis(),
	}
	s.current = &written
	copied := written
	return &copied, nil
}

// GenerateInitialPassword 拒绝采样生成初始密码：字节落在 charset 长度的整数倍区间外
// 即弃用，分布无偏。16 字符、字符集剔除 0O1lI 歧义字符。
func GenerateInitialPassword() string {
	limit := 256 / len(InitialPasswordCharset) * len(InitialPasswordCharset)
	password := make([]byte, 0, InitialPasswordLength)
	for len(password) < InitialPasswordLength {
		bytes := make([]byte, InitialPasswordLength*2)
		if _, err := crand.Read(bytes); err != nil {
			panic(fmt.Sprintf("系统随机源不可用：%v", err))
		}
		for _, b := range bytes {
			if int(b) >= limit {
				continue
			}
			password = append(password, InitialPasswordCharset[int(b)%len(InitialPasswordCharset)])
			if len(password) == InitialPasswordLength {
				break
			}
		}
	}
	return string(password)
}

// FirstBootOutcome 首启保障的三种结局。
type FirstBootOutcome int

const (
	// FirstBootDevSkipped dev 开：只打警告行，不生成文件。
	FirstBootDevSkipped FirstBootOutcome = iota
	// FirstBootAlreadyPresent 凭据文件已存在：直接返回，不打印。
	FirstBootAlreadyPresent
	// FirstBootCreated 首启生成初始密码并落盘，横幅已打印（密码只显示这一次）。
	FirstBootCreated
)

// firstBootOptions 首启保障的注入项（测试注入打印与密码生成；缺省走真实实现）。
type firstBootOptions struct {
	dev              bool
	hasher           PasswordHasher
	generatePassword func() string
	print            func(line string)
}

// ensureFirstBootCredentials 首启保障（装配层副作用）：
// dev 开 → 只打警告行（AuthDevWarning），不生成文件；凭据文件已存在 → 直接返回；
// 已有但无效的文件拒绝覆盖；确实缺失时才生成 16 字符随机密码（无歧义字符集），
// scrypt 落盘后向 stdout 打一次性横幅。
// 初始密码只显示这一次、不落任何日志文件。
func ensureFirstBootCredentials(store CredentialsStore, options firstBootOptions) (FirstBootOutcome, error) {
	print := options.print
	if print == nil {
		print = func(line string) { fmt.Println(line) }
	}
	if options.dev {
		print(AuthDevWarning)
		return FirstBootDevSkipped, nil
	}
	if locker, ok := store.(interface{ lockFirstBoot() (func(), error) }); ok {
		unlock, err := locker.lockFirstBoot()
		if err != nil {
			return FirstBootDevSkipped, err
		}
		defer unlock()
	}
	if existing, err := store.Current(); err != nil {
		return FirstBootDevSkipped, err
	} else if existing != nil {
		return FirstBootAlreadyPresent, nil
	}
	if checker, ok := store.(interface{ credentialFileExists() (bool, error) }); ok {
		exists, err := checker.credentialFileExists()
		if err != nil {
			return FirstBootDevSkipped, err
		}
		if exists {
			return FirstBootDevSkipped, fmt.Errorf("面板凭据文件已存在但不可用，拒绝自动生成替代密码；请检查文件权限或执行 elysian resetpwd")
		}
	}

	hasher := options.hasher
	if hasher == nil {
		hasher = NewScryptHasher()
	}
	generate := options.generatePassword
	if generate == nil {
		generate = GenerateInitialPassword
	}
	password := generate()
	hash, err := hasher.Hash(password)
	if err != nil {
		return FirstBootDevSkipped, err
	}
	if _, err := store.Write(hash); err != nil {
		return FirstBootDevSkipped, err
	}
	print("==================================================")
	print("Elysian 面板已生成初始管理员账号")
	print("用户名：" + PanelUsername)
	print("初始密码：" + password)
	print("密码只显示这一次，请立即登录并妥善保管。")
	// 改密指引与安装摘要同口径（ely 菜单是主入口，脚本通道须带生产 STATE_DIR 的 HOME，
	// 避免 root 照横幅直接跑写错目录——面板密码实际未变）。
	print("修改密码：sudo ely 后选择「重置密码」（脚本通道：HOME=/var/lib/elysian elysian resetpwd）")
	print("==================================================")
	return FirstBootCreated, nil
}

// FirstBootCredentials main 启动序列的首启保障入口：created 为 true 时调用方（装配层）
// 补一条「面板初始密码已生成（admin）」运行日志。dev 开关与凭据路径取自 cfg 与缺省路径表。
func FirstBootCredentials(cfg *config.Config) (created bool, err error) {
	outcome, err := ensureFirstBootCredentials(NewFileCredentialsStore(""), firstBootOptions{dev: cfg.AuthDev})
	if err != nil {
		return false, err
	}
	return outcome == FirstBootCreated, nil
}
