package panel

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestRecheckCLILinkMutationMustHaveDurableIntent(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, func(context.Context, string, string) error { return nil })
	locked, release, lockDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() { lockDone <- w.Store.lock(func() error { close(locked); <-release; return nil }) }()
	<-locked
	workerDone := make(chan error, 1)
	go func() { workerDone <- w.ensureCLILink(context.Background(), r) }()
	defer func() { close(release); <-lockDone; <-workerDone }()
	// 锁阻塞事实保存；若先记录意图，就不应已经修改系统链接。
	deadline := time.After(time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Lstat(cli); err == nil {
			stored, err := w.Store.read(r.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !stored.CLICreated && stored.CLIRelinkedFrom == "" {
				t.Fatal("系统链接已创建，但持久任务无创建/改指意图；此时中断后恢复无法回滚该链接")
			}
			return
		}
		select {
		case <-deadline:
			return
		case <-tick.C:
		}
	}
}
