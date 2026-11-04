package docker

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentCredentialStoreRoundTripAndUpsert(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-service-containers.json")
	store := newAgentCredentialStore(path)
	if found, err := store.find("mysql-main"); err != nil || found != nil {
		t.Fatalf("空存储应无记录 found=%v err=%v", found, err)
	}
	first := agentServiceCredentialRecord{
		Name: "mysql-main", ContainerID: strings.Repeat("c", 64),
		Credentials: map[string]string{"MYSQL_ROOT_PASSWORD": generateAgentSecret()},
		VolumeNames: []string{"elysian-agent-1"}, NetworkScope: "any-host", HostPort: 3306,
		Port: 3306, ResourceTier: "medium", CreatedAt: "2026-11-04T00:00:00Z",
	}
	if err := store.save(first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ContainerID = strings.Repeat("d", 64)
	if err := store.save(second); err != nil {
		t.Fatal(err)
	}
	reloaded := newAgentCredentialStore(path)
	found, err := reloaded.find("mysql-main")
	if err != nil || found == nil {
		t.Fatalf("重读失败 found=%v err=%v", found, err)
	}
	if found.ContainerID != second.ContainerID || found.Credentials["MYSQL_ROOT_PASSWORD"] != first.Credentials["MYSQL_ROOT_PASSWORD"] {
		t.Fatalf("upsert 后应保留凭据并更新身份：%+v", found)
	}
	if other, err := reloaded.find("redis-cache"); err != nil || other != nil {
		t.Fatalf("不应读到别的记录：%v %v", other, err)
	}
}

func TestGenerateAgentSecretShape(t *testing.T) {
	a, b := generateAgentSecret(), generateAgentSecret()
	if len(a) != 48 || len(b) != 48 || a == b {
		t.Fatalf("凭据应为 48 位十六进制且互不相同：%q %q", a, b)
	}
}

func TestAgentCredentialStoreRejectsSymlinkPath(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.json")
	store := newAgentCredentialStore(real)
	if err := store.save(agentServiceCredentialRecord{Name: "x", Credentials: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.json")
	if err := symlinkFile(t, real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := newAgentCredentialStore(link).find("x"); err == nil {
		t.Fatal("符号链接路径应被拒绝")
	}
}

func symlinkFile(t *testing.T, target, link string) error {
	t.Helper()
	return os.Symlink(target, link)
}

func TestWriteFileAtomicDockerRejectsPreexistingTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-service-containers.json")
	store := newAgentCredentialStore(path)
	if err := store.save(agentServiceCredentialRecord{Name: "x", Credentials: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	temporary := path + "." + fmt.Sprintf("%d", os.Getpid()) + ".tmp"
	const preset = "预置内容"
	if err := os.WriteFile(temporary, []byte(preset), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.save(agentServiceCredentialRecord{Name: "y", Credentials: map[string]string{}}); err == nil {
		t.Fatal("临时文件已存在时 save 应失败")
	}
	if after, err := os.ReadFile(path); err != nil || string(after) != string(before) {
		t.Fatalf("登记目标不应被覆盖：err=%v", err)
	}
	if got, err := os.ReadFile(temporary); err != nil || string(got) != preset {
		t.Fatalf("预置临时文件内容不应被改动：err=%v content=%q", err, string(got))
	}
	// 同名临时位置换成符号链接（F1 的攻击形态）：打开必须同样失败，链接目标不被写入。
	victim := filepath.Join(dir, "victim.txt")
	const sentinel = "受害者原内容"
	if err := os.WriteFile(victim, []byte(sentinel), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(temporary); err != nil {
		t.Fatal(err)
	}
	if err := symlinkFile(t, victim, temporary); err != nil {
		t.Fatal(err)
	}
	if err := store.save(agentServiceCredentialRecord{Name: "z", Credentials: map[string]string{}}); err == nil {
		t.Fatal("临时位置为符号链接时 save 应失败")
	}
	if got, err := os.ReadFile(victim); err != nil || string(got) != sentinel {
		t.Fatalf("符号链接目标不应被写入：err=%v content=%q", err, string(got))
	}
	if after, err := os.ReadFile(path); err != nil || string(after) != string(before) {
		t.Fatalf("登记目标在符号链接尝试后仍不应被覆盖：err=%v", err)
	}
}
