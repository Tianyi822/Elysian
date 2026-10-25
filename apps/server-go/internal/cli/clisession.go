package cli

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// ely 的本地持久化（CLI 方案 §3.3／§6.3）：会话 Cookie 与后端地址存执行用户
// $HOME/.elysian/cli/session.json（0600、原子写、只存 Cookie 值与地址，绝不存
// 密码）；会话指针与每会话思考档选择存 state.json。两者都是用户级文件，与面板
// 数据（~/.Elysian）无关；ELYSIAN_PANEL_HOME 不改变本目录。

// cliStore 读写本地凭据与状态。
type cliStore struct {
	dir string
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
	SelectedSessionID string            `json:"selectedSessionId,omitempty"`
	ReasoningLevels   map[string]string `json:"reasoningLevels,omitempty"`
	PermissionModes   map[string]string `json:"permissionModes,omitempty"`
	Drafts            map[string]string `json:"drafts,omitempty"`
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
	var state StoredState
	raw, err := readLocalFile(s.statePath())
	if err != nil || raw == nil {
		return state, err
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return StoredState{}, nil
	}
	return state, nil
}

// WriteState 原子保存状态。
func (s *cliStore) WriteState(state StoredState) error {
	return writeLocalFile(s.statePath(), state)
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
	return os.Rename(temporary.Name(), path)
}
