package panel

import (
	"crypto/rand"
	"elysian/server/internal/config"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var requestPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{8,80}$`)
var commitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

type Store struct{ Root string }

func (s Store) updateCheckPath(channel UpdateChannel) string {
	name := "panel-update-check.json"
	if channel == ChannelRelease {
		name = "panel-update-check-release.json"
	}
	return filepath.Join(s.Root, "state", name)
}

// 请求写操作持共享锁，维护提交持独占锁，等待已经开始的写请求结束。
func (s Store) mutationGate(shared bool, fn func() error) error {
	if err := os.MkdirAll(s.tasksDir(), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.tasksDir(), "operations.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	mode := syscall.LOCK_EX
	if shared {
		mode = syscall.LOCK_SH
	}
	if err = syscall.Flock(int(f.Fd()), mode); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

func (s Store) tasksDir() string          { return filepath.Join(s.Root, "state", "panel-maintenance") }
func (s Store) networkPath() string       { return filepath.Join(s.Root, "config", "panel-network.json") }
func (s Store) taskPath(id string) string { return filepath.Join(s.tasksDir(), id+".json") }
func (s Store) logPath(id string) string  { return filepath.Join(s.tasksDir(), id+".log") }

func (s Store) lock(fn func() error) error {
	if err := os.MkdirAll(s.tasksDir(), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.tasksDir(), "store.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

func (s Store) read(id string) (taskRecord, error) {
	var r taskRecord
	if !idPattern.MatchString(id) {
		return r, fmt.Errorf("任务编号无效")
	}
	b, err := os.ReadFile(s.taskPath(id))
	if err != nil {
		return r, err
	}
	err = json.Unmarshal(b, &r)
	if err != nil {
		return r, fmt.Errorf("维护任务记录损坏：%w", err)
	}
	if r.ID != id || r.OldPorts.Validate() != nil || r.NewPorts.Validate() != nil {
		return r, fmt.Errorf("维护任务记录字段无效：%s", id)
	}
	switch r.Kind {
	case "ports", "restart", "update":
	default:
		return r, fmt.Errorf("维护任务类型无效：%s", id)
	}
	switch r.State {
	case "queued", "running", "succeeded", "failed", "rolled-back", "recovery-failed":
	default:
		return r, fmt.Errorf("维护任务状态无效：%s", id)
	}
	return r, nil
}

func (s Store) records() ([]taskRecord, error) {
	entries, err := os.ReadDir(s.tasksDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows := []taskRecord{}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		r, err := s.read(e.Name()[:len(e.Name())-5])
		if err != nil {
			return nil, err
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt.After(rows[j].CreatedAt) })
	return rows, nil
}

func (s Store) save(r taskRecord) error { return config.AtomicJSON(s.taskPath(r.ID), r) }

func newID() (string, error) {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}

// appendLog 限制持久化输出；超过上限仍排空进程输出，避免卡住构建进程。
func (s Store) appendLog(id, text string) {
	f, err := os.OpenFile(s.logPath(id), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() >= 2*1024*1024 {
		return
	}
	remaining := 2*1024*1024 - st.Size()
	if int64(len(text)) > remaining {
		text = text[:remaining]
	}
	_, _ = f.WriteString(text)
}
