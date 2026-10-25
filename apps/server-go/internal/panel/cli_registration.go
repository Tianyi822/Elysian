package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"elysian/server/internal/shared"
)

func (m Manager) cliWorker() Worker {
	return Worker{Store: m.Store, Install: m.Install, CLIBin: m.CLIBin, CLIVerify: m.CLIVerify}
}
func (m Manager) withCLIStatus(r taskRecord) taskRecord {
	if r.Kind != "update" || r.State != "succeeded" {
		return r
	}
	if Commit != "unknown" && r.TargetCommit != Commit {
		return r
	}
	if r.CLIRegistration != nil {
		return r
	}
	var j cliJournal
	if raw, err := os.ReadFile(m.Store.cliJournalPath(r.ID)); err == nil {
		if json.Unmarshal(raw, &j) == nil {
			r.CLIRegistration = &CLIRegistration{Status: j.State, Error: j.Error}
		} else {
			r.CLIRegistration = &CLIRegistration{Status: "failed", Error: "CLI 注册日志损坏，请检查维护目录"}
		}
	} else if os.IsNotExist(err) {
		r.CLIRegistration = &CLIRegistration{Status: "pending"}
	}
	return r
}

// 仅挂在新服务生命周期中；旧 worker 已提交并释放锁后才补注册。
func (m Manager) StartCLIRegistration() func(context.Context) error {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if !m.Enabled {
			return
		}
		timer := time.NewTicker(time.Second)
		defer timer.Stop()
		for {
			finished, err := m.registerCommittedCLI(ctx, "")
			if err != nil {
				fmt.Fprintf(os.Stderr, "Elysian CLI 注册：%v\n", err)
			}
			if finished {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
	return func(closeCtx context.Context) error {
		cancel()
		select {
		case <-done:
			return nil
		case <-closeCtx.Done():
			return closeCtx.Err()
		}
	}
}

func (m Manager) retryCLIRegistration(ctx context.Context, id string) (Task, error) {
	if !idPattern.MatchString(id) {
		return Task{}, shared.InvalidRequest("任务编号无效")
	}
	if !m.Enabled {
		return Task{}, shared.InvalidRequest("仅 systemd 安装版支持 CLI 注册")
	}
	finished, err := m.registerCommittedCLI(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !finished {
		return Task{}, &shared.InvalidRequestError{Status: 409, Message: "维护尚未提交或执行锁未释放，请稍后重试"}
	}
	row, err := m.Store.read(id)
	return m.withCLIStatus(row).Task, err
}

func (m Manager) registerCommittedCLI(ctx context.Context, retryID string) (bool, error) {
	finished := false
	err := m.Store.mutationGate(false, func() error {
		lock, err := m.Store.tryWorkerLock()
		if err != nil {
			if errors.Is(err, syscall.EWOULDBLOCK) {
				return nil
			}
			return err
		}
		defer lock.Close()
		defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		rows, err := m.Store.records()
		if err != nil {
			return err
		}
		for _, r := range rows {
			if Active(r.State) || r.State == "recovery-failed" {
				return nil
			}
		}
		var record *taskRecord
		for i := range rows {
			if rows[i].Kind == "update" && rows[i].Committed && rows[i].State == "succeeded" {
				record = &rows[i]
				break
			}
		}
		if record == nil {
			finished = true
			if retryID != "" {
				return shared.InvalidRequest("没有已提交的更新可补注册 CLI")
			}
			return nil
		}
		if retryID != "" && record.ID != retryID {
			return &shared.InvalidRequestError{Status: 409, Message: "该任务已不是当前版本，不能重试 CLI 注册"}
		}
		if Commit != "unknown" && record.TargetCommit != Commit {
			finished = true
			if retryID != "" {
				return &shared.InvalidRequestError{Status: 409, Message: "该任务目标不是当前运行版本，不能注册 CLI"}
			}
			return nil
		}
		row := m.withCLIStatus(*record)
		if retryID == "" && row.CLIRegistration != nil && (row.CLIRegistration.Status == "succeeded" || row.CLIRegistration.Status == "failed") {
			finished = true
			return nil
		}
		fail := func(cause error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			row.CLIRegistration = &CLIRegistration{Status: "failed", Error: cause.Error()}
			if saveErr := m.Store.lock(func() error { return m.Store.save(row) }); saveErr != nil {
				return saveErr
			}
			m.Store.appendLog(row.ID, "面板升级成功，CLI 注册失败："+cause.Error()+"；可在设置页重试\n")
			finished = true
			return nil
		}
		worker := m.cliWorker()
		executable := m.Executable
		if executable == "" {
			executable, err = os.Executable()
			if err != nil {
				return fail(err)
			}
		}
		actual, err := os.Stat(executable)
		if err != nil {
			return fail(err)
		}
		current, err := os.Stat(filepath.Join(worker.install(), "current", "elysian"))
		if err != nil {
			return fail(err)
		}
		if !os.SameFile(actual, current) {
			finished = true
			return fail(fmt.Errorf("当前服务并非已提交版本的二进制，拒绝注册 CLI"))
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		err = worker.ensureCLILink(ctx, &row)
		if err != nil {
			return fail(err)
		} else {
			m.Store.appendLog(row.ID, "CLI 命令注册成功：ely\n")
		}
		finished = true
		return nil
	})
	return finished, err
}
