package panel

import (
	"crypto/rand"
	"elysian/server/internal/config"
	"elysian/server/internal/shared"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"
	"time"
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var requestPattern = regexp.MustCompile(`^[a-zA-Z0-9-]{8,80}$`)
var commitPattern = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

type Store struct{ Root string }

func (s Store) updateCheckPath(channel UpdateChannel, source UpdateSource) string {
	source = normalizeSource(source)
	name := "panel-update-check.json"
	if source != SourceAuto {
		name = "panel-update-check-" + string(source) + "-commit.json"
		if channel == ChannelRelease {
			name = "panel-update-check-" + string(source) + "-release.json"
		}
	} else if channel == ChannelRelease {
		name = "panel-update-check-release.json"
	}
	return filepath.Join(s.Root, "state", name)
}

// 互斥等待上限：独占等待（维护提交）25 秒——低于前端 30 秒中止，「面板正忙」能回到
// 浏览器而不是让用户只看到连接超时；共享等待（普通写请求）90 秒——只需覆盖一次维护
// 提交或安装脚本的独占持有。并发长写（如上传全程持共享锁）不再把提交无限期挂起。
var (
	exclusiveGateWait = 25 * time.Second
	sharedGateWait    = 90 * time.Second
)

// 请求写操作持共享锁，维护提交持独占锁，等待已经开始的写请求结束；等待按上面的
// 上限及时以中文错误拒绝，由前端提示稍后重试。
func (s Store) mutationGate(sharedLock bool, fn func() error) error {
	if err := os.MkdirAll(s.tasksDir(), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.tasksDir(), "operations.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	mode := syscall.LOCK_EX
	wait := exclusiveGateWait
	busy := &shared.InvalidRequestError{Status: 503, Message: "面板正忙，请稍后重试"}
	if sharedLock {
		mode = syscall.LOCK_SH
		wait = sharedGateWait
		busy = &shared.InvalidRequestError{Status: 409, Message: "面板正在维护，暂不能修改配置或执行部署，请稍后重试"}
	}
	deadline := time.Now().Add(wait)
	for {
		err = syscall.Flock(int(f.Fd()), mode|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err == syscall.EINTR {
			continue
		}
		if err != syscall.EWOULDBLOCK || time.Now().After(deadline) {
			return busy
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

func (s Store) tasksDir() string          { return filepath.Join(s.Root, "state", "panel-maintenance") }
func (s Store) networkPath() string       { return filepath.Join(s.Root, "config", "panel-network.json") }
func (s Store) taskPath(id string) string { return filepath.Join(s.tasksDir(), id+".json") }
func (s Store) logPath(id string) string  { return filepath.Join(s.tasksDir(), id+".log") }

func (s Store) tryWorkerLock() (*os.File, error) {
	if err := os.MkdirAll(s.tasksDir(), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(s.tasksDir(), "worker.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

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
