package panel

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/config"
)

func TestMaintenanceLedgerReadDirContract(t *testing.T) {
	s := Store{Root: t.TempDir()}
	if rows, err := s.records(); rows != nil || err != nil {
		t.Fatalf("缺失目录应返回 nil 记录且不报错：%v，%v", rows, err)
	}
	ports := config.DefaultPanelNetwork()
	first := taskRecord{Task: Task{
		ID: strings.Repeat("a", 32), Kind: "restart", State: "succeeded",
		CreatedAt: time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC), OldPorts: ports, NewPorts: ports,
	}}
	latest := first
	latest.ID, latest.CreatedAt = strings.Repeat("b", 32), first.CreatedAt.Add(time.Hour)
	for _, r := range []taskRecord{first, latest} {
		if err := s.save(r); err != nil {
			t.Fatal(err)
		}
		want, err := json.MarshalIndent(r, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(s.tasksDir(), r.ID+".json"))
		if err != nil || !bytes.Equal(raw, append(want, '\n')) {
			t.Fatalf("维护记录没有保持原路径和 JSON 格式：%s，%v", raw, err)
		}
	}
	if err := os.WriteFile(filepath.Join(s.tasksDir(), "store.lock"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	rows, err := s.records()
	if err != nil || len(rows) != 2 || rows[0].ID != latest.ID || rows[1].ID != first.ID {
		t.Fatalf("应只列出任务，并按创建时间降序：%v，%v", rows, err)
	}
	if err := os.WriteFile(s.taskPath(strings.Repeat("c", 32)), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	rows, err = s.records()
	var syntax *json.SyntaxError
	if rows != nil || !errors.As(err, &syntax) || err.Error() != "维护任务记录损坏：unexpected end of JSON input" {
		t.Fatalf("坏任务应中止枚举并保留原因：%v，%v", rows, err)
	}
}
