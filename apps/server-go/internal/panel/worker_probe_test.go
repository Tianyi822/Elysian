package panel

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestParseWorkerStatusRequiresExplicitSystemdState(t *testing.T) {
	for _, tc := range []struct {
		name string
		out  string
		want WorkerStatus
	}{
		{"running", "LoadState=loaded\nActiveState=active\n", WorkerAlive},
		{"starting", "LoadState=loaded\nActiveState=activating\n", WorkerAlive},
		{"stopping", "LoadState=loaded\nActiveState=deactivating\n", WorkerAlive},
		{"reloading", "LoadState=loaded\nActiveState=reloading\n", WorkerAlive},
		{"stopped", "LoadState=loaded\nActiveState=inactive\n", WorkerDead},
		{"failed", "LoadState=loaded\nActiveState=failed\n", WorkerDead},
		{"collected", "ActiveState=inactive\nLoadState=not-found", WorkerDead},
		{"bus-error", "Failed to connect to bus", WorkerUnknown},
		{"empty", "", WorkerUnknown},
		{"missing-field", "ActiveState=inactive\n", WorkerUnknown},
		{"duplicate", "LoadState=loaded\nActiveState=inactive\nActiveState=active\n", WorkerUnknown},
		{"contradiction", "LoadState=not-found\nActiveState=active\n", WorkerUnknown},
		{"unknown-state", "LoadState=loaded\nActiveState=unexpected\n", WorkerUnknown},
		{"load-error", "LoadState=error\nActiveState=inactive\n", WorkerUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseWorkerStatus(tc.out); got != tc.want {
				t.Fatalf("进程状态误判：%q %s != %s", tc.out, got, tc.want)
			}
		})
	}
}

func TestSystemHostProbeErrorsRemainUnknown(t *testing.T) {
	for _, tc := range []struct {
		name   string
		script string
		cancel bool
		want   WorkerStatus
	}{
		{"active", "printf 'LoadState=loaded\\nActiveState=active\\n'", false, WorkerAlive},
		{"command-error", "printf 'LoadState=loaded\\nActiveState=inactive\\n'; exit 1", false, WorkerUnknown},
		{"bus-error", "printf 'Failed to connect to bus\\n'; exit 1", false, WorkerUnknown},
		{"absent-unit", "printf 'ActiveState=inactive\\nLoadState=not-found'; exit 4", false, WorkerDead},
		{"cancelled", "printf 'LoadState=loaded\\nActiveState=inactive\\n'", true, WorkerUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte("#!/bin/sh\n"+tc.script+"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancel {
				cancel()
			}
			if got := (SystemHost{}).ProbeWorker(ctx, "test"); got != tc.want {
				t.Fatalf("命令错误未保留未知：%s != %s", got, tc.want)
			}
		})
	}
}
