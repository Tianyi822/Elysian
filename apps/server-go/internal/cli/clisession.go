package cli

import (
	"elysian/server/internal/cli/tui"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
	"time"
)

// ely 的本地持久化（CLI 方案 §3.3／§6.3）：会话 Cookie 与后端地址存执行用户
// $HOME/.elysian/cli/session.json（0600、原子写、只存 Cookie 值与地址，绝不存
// 密码）；会话指针与每会话思考档选择存 state.json。两者都是用户级文件，与面板
// 数据（~/.Elysian）无关；ELYSIAN_PANEL_HOME 不改变本目录。

// cliStore 读写本地凭据与状态。
type cliStore struct {
	mu       sync.Mutex
	baseline *StoredState
	dir      string
}

// StoredSession 本地凭据：后端地址与会话 Cookie（被顶／过期／登出时清除）。
type StoredSession struct {
	BaseURL string `json:"baseURL"`
	Cookie  string `json:"cookie"`
}

// StoredState TUI 本地状态：上次选中会话指针、每会话思考档／权限模式选择与输入
// 草稿（服务端会话不保存思考档、权限模式与草稿；思考档与权限模式逐轮提交时消费，
// 草稿在返回列表／退出 TUI 时回填）。
type StoredState struct {
	Version           int                         `json:"version,omitempty"`
	Sessions          map[string]tui.LocalSession `json:"sessions,omitempty"`
	SelectedSessionID string                      `json:"selectedSessionId,omitempty"`
	ReasoningLevels   map[string]string           `json:"reasoningLevels,omitempty"`
	PermissionModes   map[string]string           `json:"permissionModes,omitempty"`
	Drafts            map[string]string           `json:"drafts,omitempty"`
}

// newCLIStore 按用户主目录构造存储（dir 为空时按 $HOME/.elysian/cli 解析）。
func newCLIStore(dir string) (*cliStore, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".elysian", "cli")
	}
	return &cliStore{dir: dir}, nil
}

// sessionPath / statePath 文件落点。
func (s *cliStore) sessionPath() string { return filepath.Join(s.dir, "session.json") }
func (s *cliStore) statePath() string   { return filepath.Join(s.dir, "state.json") }

// ReadSession 读取本地凭据；文件不存在返回零值（首次使用或已登出）。
func (s *cliStore) ReadSession() (StoredSession, error) {
	var stored StoredSession
	raw, err := readLocalFile(s.sessionPath())
	if err != nil || raw == nil {
		return stored, err
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		// 损坏文件按未登录处理，不阻断进入登录流程。
		return StoredSession{}, nil
	}
	return stored, nil
}

// WriteSession 原子保存凭据（目录 0700、文件 0600）。
func (s *cliStore) WriteSession(stored StoredSession) error {
	return writeLocalFile(s.sessionPath(), stored)
}

// ClearSession 清除本地凭据（被顶／过期／登出）。
func (s *cliStore) ClearSession() error {
	err := os.Remove(s.sessionPath())
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// ReadState 读取本地状态；文件不存在返回零值。
func (s *cliStore) ReadState() (StoredState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.readState()
	if err == nil {
		copy := cloneCLIState(state)
		s.baseline = &copy
	}
	return state, err
}
func (s *cliStore) readState() (StoredState, error) {
	var state StoredState
	raw, err := readLocalFile(s.statePath())
	if err != nil || raw == nil {
		return state, err
	}
	if err = json.Unmarshal(raw, &state); err != nil {
		return state, fmt.Errorf("状态文件损坏，已保留原文件：%w", err)
	}
	if state.Version > 2 {
		return state, fmt.Errorf("本地状态版本高于此 CLI 支持的版本")
	}
	return state, nil
}
func cloneCLIState(s StoredState) StoredState {
	b, _ := json.Marshal(s)
	var copy StoredState
	_ = json.Unmarshal(b, &copy)
	return copy
}

// WriteState 在文件锁内仅合并此进程改动的会话，冲突保持磁盘原状态。
func (s *cliStore) WriteState(state StoredState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(s.dir, "state.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK || time.Now().After(deadline) {
			return fmt.Errorf("本地状态正由另一 CLI 保存，请重试：%w", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	current, err := s.readState()
	if err != nil {
		return err
	}
	before := StoredState{}
	if s.baseline != nil {
		before = *s.baseline
	} else {
		before = cloneCLIState(current)
	}
	if current.Sessions == nil {
		current.Sessions = map[string]tui.LocalSession{}
	}
	if current.Drafts == nil {
		current.Drafts = map[string]string{}
	}
	if current.ReasoningLevels == nil {
		current.ReasoningLevels = map[string]string{}
	}
	if current.PermissionModes == nil {
		current.PermissionModes = map[string]string{}
	}
	keys := map[string]bool{}
	for _, v := range []StoredState{before, state} {
		for k := range v.Sessions {
			keys[k] = true
		}
		for k := range v.Drafts {
			keys[k] = true
		}
		for k := range v.ReasoningLevels {
			keys[k] = true
		}
		for k := range v.PermissionModes {
			keys[k] = true
		}
	}
	for id := range keys {
		if reflect.DeepEqual(localStateValue(before, id), localStateValue(state, id)) {
			continue
		}
		if current.Sessions[id].Revision != before.Sessions[id].Revision || !reflect.DeepEqual(localStateValue(current, id), localStateValue(before, id)) {
			return fmt.Errorf("会话 %s 已被另一个 CLI 修改，请重新打开以回读状态；本次请求未派发", id)
		}
		if local, ok := state.Sessions[id]; ok {
			local.Revision = current.Sessions[id].Revision + 1
			current.Sessions[id] = local
		} else {
			delete(current.Sessions, id)
		}
		copyEntry(current.Drafts, state.Drafts, id)
		copyEntry(current.ReasoningLevels, state.ReasoningLevels, id)
		copyEntry(current.PermissionModes, state.PermissionModes, id)
	}
	current.Version = 2
	current.SelectedSessionID = state.SelectedSessionID
	if err = writeLocalFile(s.statePath(), current); err != nil {
		return err
	}
	copy := cloneCLIState(state)
	for id, local := range copy.Sessions {
		local.Revision = current.Sessions[id].Revision
		copy.Sessions[id] = local
	}
	s.baseline = &copy
	return nil
}
func localStateValue(s StoredState, id string) any {
	local, exists := s.Sessions[id]
	local.Revision = 0
	return struct {
		Local              tui.LocalSession
		Exists             bool
		Draft, Level, Mode string
	}{local, exists, s.Drafts[id], s.ReasoningLevels[id], s.PermissionModes[id]}
}
func copyEntry(dst, src map[string]string, id string) {
	if value, ok := src[id]; ok {
		dst[id] = value
	} else {
		delete(dst, id)
	}
}

// readLocalFile 读取本地 JSON 文件；不存在返回 (nil, nil)。
func readLocalFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return raw, nil
}

// writeLocalFile 原子写（与 auth.fsx 同纪律的本地精简版）：目录 0700、临时文件
// 0600 + fsync + rename；payload 为 JSON 编码。
func writeLocalFile(path string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
