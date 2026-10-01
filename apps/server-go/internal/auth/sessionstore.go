package auth

import (
	crand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"sync"
	"time"

	"elysian/server/internal/paths"
)

// 服务端会话存储（sessionStore.ts 等价物）：~/.Elysian/state/panel-sessions.json
//（0600、临时文件 + 原子 rename）。会话是服务端事实，Cookie 只承载不透明 id
//（32 字节随机数的 base64url，恒 43 字符）。
//
// 生命周期（全部服务端权威）：空闲 12 小时（滑动窗口，严格大于才过期——差 1ms 仍有效）
// 或绝对 7 天即过期；epoch 失效：会话记录的 pwdEpoch 与当前凭据的 passwordChangedAt
// 不一致即删除——改密后全部既有会话在下一次请求时 401。惰性清扫：任一 validate 顺带
// 剔除已过期会话；单用户场景会话数个位数，无需定时器。
//
// 落盘时机（被测试逐字节锚定，不得改动）：create 与 destroy 立即写文件；lastUsedAt
// 滑动只改内存（无删除发生时不写文件，随下一次 create/destroy 顺带落盘）；纯未命中
// 不写；destroy/destroyOthers 无变化不写；list 只读过滤不落盘。
//
// 文件版首载后持内存镜像（CLI 不碰会话文件，无跨进程写竞争）；写路径互斥（TS promise
// 链 → Go mutex）保证 destroy 与 create 不交错。

// PanelSession 一条面板会话。CreatedAt/LastUsedAt 是 epoch 毫秒。
type PanelSession struct {
	ID         string `json:"id"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
	PwdEpoch   string `json:"pwdEpoch"`
}

// SessionStore 会话存取接口。
type SessionStore interface {
	// Create 新建会话并立即落盘（文件版）。
	Create(pwdEpoch string) (*PanelSession, error)
	// Validate 校验并滑动续期；会话不存在、过期或 epoch 不匹配时删除并回 nil。
	Validate(sessionID, pwdEpoch string) (*PanelSession, error)
	// Destroy 销毁单个会话；无匹配不写文件。
	Destroy(sessionID string) error
	// List 只读列举未过期会话：过期会话就地过滤、不落盘（清扫仍由 Validate 顺带完成）。
	List() ([]PanelSession, error)
	// DestroyOthers 销毁除 keepSessionID 外的全部会话；集合未变则不写文件。
	DestroyOthers(keepSessionID string) error
}

// sessionStoreCore 文件版与内存版共用的核心状态机：writer 为 nil 时即内存版（commit
// 只改内存），非 nil 时 forceWrite 走原子落盘。
type sessionStoreCore struct {
	mu     sync.Mutex
	path   string
	now    func() time.Time
	writer func(sessions []PanelSession) error
	loaded bool
	cached []PanelSession
}

// NewFileSessionStore 构造文件版会话存储；path 传空串时用 ~/.Elysian 缺省路径。
// now 为可控时钟（测试注入），nil 用 time.Now。
func NewFileSessionStore(path string, now func() time.Time) SessionStore {
	if path == "" {
		path = paths.Default.PanelSessions
	}
	if now == nil {
		now = time.Now
	}
	store := &sessionStoreCore{path: path, now: now}
	store.writer = func(sessions []PanelSession) error {
		return writeSessionsFile(path, sessions)
	}
	return store
}

// NewMemorySessionStore 构造内存版会话存储（测试用，不碰文件系统，语义与文件版一致）。
func NewMemorySessionStore(now func() time.Time) SessionStore {
	if now == nil {
		now = time.Now
	}
	return &sessionStoreCore{now: now}
}

// newSessionID 32 字节随机数的 base64url，恒 43 字符。
func newSessionID() string {
	b := make([]byte, 32)
	if _, err := crand.Read(b); err != nil {
		panic("系统随机源不可用：" + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// isExpiredMs 严格大于才过期：now-lastUsedAt > IDLE 或 now-createdAt > ABSOLUTE。
func (s *sessionStoreCore) isExpired(session PanelSession, now time.Time) bool {
	idle := now.Sub(time.UnixMilli(session.LastUsedAt))
	absolute := now.Sub(time.UnixMilli(session.CreatedAt))
	return idle > SessionIdleTTL || absolute > SessionAbsoluteTTL
}

// load 取内存镜像；文件版首载从磁盘读（缺失/损坏/权限异常一律回空表——fail closed：
// 全部会话失效），此后不再重读文件。
func (s *sessionStoreCore) load() ([]PanelSession, error) {
	if !s.loaded {
		if s.writer != nil {
			loaded, err := readSessionsFile(s.path)
			if err != nil {
				return nil, err
			}
			s.cached = loaded
		}
		s.loaded = true
	}
	return s.cached, nil
}

// commit 更新内存镜像；forceWrite 且为文件版时立即落盘（写失败原样上抛给调用方）。
func (s *sessionStoreCore) commit(next []PanelSession, forceWrite bool) error {
	s.cached = next
	if forceWrite && s.writer != nil {
		return s.writer(next)
	}
	return nil
}

// Create 实现 SessionStore。
func (s *sessionStoreCore) Create(pwdEpoch string) (*PanelSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	loaded, err := s.load()
	if err != nil {
		return nil, err
	}
	at := s.now()
	session := PanelSession{ID: newSessionID(), CreatedAt: at.UnixMilli(), LastUsedAt: at.UnixMilli(), PwdEpoch: pwdEpoch}
	next := make([]PanelSession, 0, len(loaded)+1)
	next = append(next, loaded...)
	next = append(next, session)
	if err := s.commit(next, true); err != nil {
		return nil, err
	}
	copied := session
	return &copied, nil
}

// Validate 实现 SessionStore。
func (s *sessionStoreCore) Validate(sessionID, pwdEpoch string) (*PanelSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.now()
	loaded, err := s.load()
	if err != nil {
		return nil, err
	}
	// 惰性清扫：先剔除全部过期会话（含被查的这个），被查者不在幸存集合里即回 nil。
	survivors := make([]PanelSession, 0, len(loaded))
	for _, session := range loaded {
		if !s.isExpired(session, at) {
			survivors = append(survivors, session)
		}
	}
	swept := len(survivors) != len(loaded)
	var target *PanelSession
	for i := range survivors {
		if survivors[i].ID == sessionID {
			copied := survivors[i]
			target = &copied
			break
		}
	}
	if target == nil {
		// 有实际删除（含被查会话本身过期）才落盘；纯未命中不写文件。
		if swept {
			if err := s.commit(survivors, true); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	if target.PwdEpoch != pwdEpoch {
		kept := make([]PanelSession, 0, len(survivors))
		for _, session := range survivors {
			if session.ID != sessionID {
				kept = append(kept, session)
			}
		}
		if err := s.commit(kept, true); err != nil {
			return nil, err
		}
		return nil, nil
	}
	slid := *target
	slid.LastUsedAt = at.UnixMilli()
	next := make([]PanelSession, len(survivors))
	copy(next, survivors)
	for i := range next {
		if next[i].ID == slid.ID {
			next[i] = slid
		}
	}
	// 滑动只改内存：无删除发生时不写文件（设计决定），随下一次 create/destroy 落盘。
	if err := s.commit(next, swept); err != nil {
		return nil, err
	}
	return &slid, nil
}

// Destroy 实现 SessionStore。
func (s *sessionStoreCore) Destroy(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	loaded, err := s.load()
	if err != nil {
		return err
	}
	found := false
	for _, session := range loaded {
		if session.ID == sessionID {
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	next := make([]PanelSession, 0, len(loaded))
	for _, session := range loaded {
		if session.ID != sessionID {
			next = append(next, session)
		}
	}
	return s.commit(next, true)
}

// List 实现 SessionStore。
func (s *sessionStoreCore) List() ([]PanelSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.now()
	loaded, err := s.load()
	if err != nil {
		return nil, err
	}
	// 只读视图：过滤过期但不落盘——读端点无副作用，磁盘上的清扫仍由 validate 顺带完成。
	listed := make([]PanelSession, 0, len(loaded))
	for _, session := range loaded {
		if !s.isExpired(session, at) {
			listed = append(listed, session)
		}
	}
	return listed, nil
}

// DestroyOthers 实现 SessionStore。
func (s *sessionStoreCore) DestroyOthers(keepSessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	loaded, err := s.load()
	if err != nil {
		return err
	}
	next := make([]PanelSession, 0, len(loaded))
	for _, session := range loaded {
		if session.ID == keepSessionID {
			next = append(next, session)
		}
	}
	// 没有其他会话时不写文件（与 destroy 的无用写规避同纪律）；有销毁则立即落盘。
	if len(next) == len(loaded) {
		return nil
	}
	return s.commit(next, true)
}

// sessionsFile 落盘形状：键序即 JSON 输出序，缩进 2（对齐 TS JSON.stringify(file, null, 2)）。
type sessionsFile struct {
	Version  int            `json:"version"`
	Sessions []PanelSession `json:"sessions"`
}

// readSessionsFile 读会话文件；打开失败的 fail-closed 集合（ENOENT/ELOOP）回空表，
// 其余 errno 原样上抛；stat/读/解析段的失败（含形状错）一律回空表（fail closed）。
func readSessionsFile(path string) ([]PanelSession, error) {
	file, err := openNoFollow(path)
	if err != nil {
		if isNoFollowMiss(err) {
			return []PanelSession{}, nil
		}
		return nil, err
	}
	defer file.Close()
	fi, err := file.Stat()
	if err != nil {
		return []PanelSession{}, nil
	}
	if !statTrusted(fi, sessionsMaxBytes) {
		return []PanelSession{}, nil
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return []PanelSession{}, nil
	}
	var parsed struct {
		Version  int               `json:"version"`
		Sessions []json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil || parsed.Version != 1 {
		return []PanelSession{}, nil
	}
	// 逐条解析：单条类型不符只丢该条（对齐 TS 的 filter 语义）；时间戳非数字、id/epoch
	// 非字符串的条目 Unmarshal 即失败。空 id（缺失或空串）一并丢弃——两者都无行为影响。
	sessions := make([]PanelSession, 0, len(parsed.Sessions))
	for _, raw := range parsed.Sessions {
		var session PanelSession
		if err := json.Unmarshal(raw, &session); err != nil {
			continue
		}
		if session.ID == "" || session.PwdEpoch == "" {
			continue
		}
		sessions = append(sessions, session)
	}
	return sessions, nil
}

// writeSessionsFile 原子写会话文件（0700 目录 + 0600 临时文件 + fsync + rename）。
func writeSessionsFile(path string, sessions []PanelSession) error {
	if sessions == nil {
		sessions = []PanelSession{}
	}
	data, err := json.MarshalIndent(sessionsFile{Version: 1, Sessions: sessions}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data)
}
