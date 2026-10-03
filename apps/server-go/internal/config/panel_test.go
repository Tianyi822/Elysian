package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPanelNetworkStrictConfiguration(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "network.json")
	if p, err := ReadPanelNetwork(filename); err != nil || p != DefaultPanelNetwork() {
		t.Fatalf("默认值错误：%v %v", p, err)
	}
	for _, text := range []string{`{`, `{"frontendPort":1}`, `{"frontendPort":48100.5,"backendPort":48101}`, `{"frontendPort":1,"backendPort":1}`, `{"frontendPort":1,"backendPort":65536}`, `{"frontendPort":1,"backendPort":2,"unknown":true}`, `{"frontendPort":1,"backendPort":2} {}`} {
		if err := os.WriteFile(filename, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadPanelNetwork(filename); err == nil {
			t.Fatalf("损坏配置被默默接受：%s", text)
		}
	}
	p := PanelNetwork{49000, 49001}
	if err := AtomicJSON(filename, p); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadPanelNetwork(filename); err != nil || got != p {
		t.Fatalf("配置无法持久化：%v %v", got, err)
	}
}
