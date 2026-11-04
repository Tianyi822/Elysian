package docker

import (
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
