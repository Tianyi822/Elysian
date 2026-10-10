package config

import (
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func openTestStore(t *testing.T) (*Store, string, Options) {
	t.Helper()
	root := t.TempDir()
	mount := filepath.Join(root, "business")
	if err := os.MkdirAll(filepath.Join(mount, "project"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config", "executions.json")
	opts := Options{MountRoot: mount, Now: func() time.Time { return time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC) }}
	s, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path, opts
}

func profileInput() ProfileInput {
	return ProfileInput{Name: "Python", Enabled: true, Image: "docker.io/library/python@sha256:" + strings.Repeat("a", 64), Runtime: "python"}
}

func requireErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var got *Error
	if !errors.As(err, &got) || got.Code != code {
		t.Fatalf("期望 %s，实际 %v", code, err)
	}
}

func TestConfigImmutableProfilesDisableAndReopen(t *testing.T) {
	s, path, opts := openTestStore(t)
	in := profileInput()
	first, err := s.PutProfile(in)
	if err != nil || first.Revision != 1 || first.TimeoutSeconds != 300 || first.CPUMillis != 1000 || first.MemoryBytes != 512<<20 || first.PIDs != 128 || first.Command[0] != "python3" {
		t.Fatalf("首个版本：%+v %v", first, err)
	}
	in.ID, in.ExpectedRevision, in.Name = first.ID, first.Revision, "Python 限额"
	in.TimeoutSeconds = 30
	second, err := s.PutProfile(in)
	if err != nil || second.Revision != 2 || second.TimeoutSeconds != 30 {
		t.Fatalf("更新：%+v %v", second, err)
	}
	old, err := s.GetProfile(first.ID, first.Revision, false)
	if err != nil || old.TimeoutSeconds != 300 || old.Name != first.Name {
		t.Fatalf("旧修订变化：%+v %v", old, err)
	}
	_, err = s.PutProfile(in)
	requireErrorCode(t, err, "execution_revision_conflict")
	disabled, err := s.SetProfileEnabled(first.ID, second.Revision, false)
	if err != nil || disabled.Revision != 3 {
		t.Fatalf("停用：%+v %v", disabled, err)
	}
	_, err = s.GetProfile(first.ID, first.Revision, false)
	requireErrorCode(t, err, "execution_profile_disabled")
	if _, err = s.GetProfile(first.ID, first.Revision, true); err != nil {
		t.Fatalf("历史修订丢失：%v", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	list, err := reopened.ListProfiles()
	if err != nil || len(list) != 1 || list[0].Revision != 3 {
		t.Fatalf("重启：%+v %v", list, err)
	}
	for _, file := range []string{path, path + ".lock"} {
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("配置权限：%v %v", info, err)
		}
	}
}

func TestConfigConcurrentCASAcrossStores(t *testing.T) {
	s, path, opts := openTestStore(t)
	other, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	first, err := s.PutProfile(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, store := range []*Store{s, other} {
		wg.Add(1)
		go func(store *Store) {
			defer wg.Done()
			in := profileInput()
			in.ID, in.ExpectedRevision = first.ID, 1
			_, err := store.PutProfile(in)
			results <- err
		}(store)
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else {
			requireErrorCode(t, err, "execution_revision_conflict")
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("并发 CAS：%d %d", success, conflict)
	}
	p, err := other.GetProfile(first.ID, 0, true)
	if err != nil || p.Revision != 2 {
		t.Fatalf("另一个实例看到旧配置：%+v %v", p, err)
	}
}

func TestConfigPublishFailurePreservesPreviousDocument(t *testing.T) {
	s, path, opts := openTestStore(t)
	first, err := s.PutProfile(profileInput())
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s.beforePublish = func() error { return errors.New("注入同步失败") }
	_, err = s.SetProfileEnabled(first.ID, 1, false)
	requireErrorCode(t, err, "execution_config_storage")
	s.beforePublish = nil
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatalf("失败覆盖文档：%v", err)
	}
	other, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	p, err := other.GetProfile(first.ID, 0, false)
	if err != nil || p.Revision != 1 {
		t.Fatalf("失败改变当前配置：%+v %v", p, err)
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasPrefix(f.Name(), ".execution-") {
			t.Fatalf("暂存未清理：%s", f.Name())
		}
	}
}

func TestConfigProfileValidation(t *testing.T) {
	s, _, _ := openTestStore(t)
	for _, image := range []string{"python:latest", "python@sha256:abc", "python@sha256:" + strings.Repeat("A", 64), "https://docker.io/python@sha256:" + strings.Repeat("a", 64)} {
		in := profileInput()
		in.Image = image
		if _, err := s.PutProfile(in); err == nil {
			t.Errorf("接受非固定镜像：%s", image)
		}
	}
	cases := []func(*ProfileInput){func(p *ProfileInput) { p.TimeoutSeconds = 301 }, func(p *ProfileInput) { p.CPUMillis = 1001 }, func(p *ProfileInput) { p.MemoryBytes = MaxMemoryBytes + 1 }, func(p *ProfileInput) { p.PIDs = 129 }, func(p *ProfileInput) { p.Runtime = "sh" }, func(p *ProfileInput) { p.Command = []string{"python3", "a\x00b"} }, func(p *ProfileInput) { p.TimeoutSeconds = -1 }}
	for _, mutate := range cases {
		in := profileInput()
		mutate(&in)
		if _, err := s.PutProfile(in); err == nil {
			t.Fatal("接受过宽或无效的执行配置")
		}
	}
	in := profileInput()
	in.Command = []string{"python3", "-m", "module", "--value", "$() is literal"}
	if _, err := s.PutProfile(in); err != nil {
		t.Fatalf("容器 argv 应原样保存：%v", err)
	}
}

func TestConfigGrantRevisionDirectoryAndSymlink(t *testing.T) {
	s, path, opts := openTestStore(t)
	project := filepath.Join(opts.MountRoot, "project")
	in := GrantInput{Name: "项目", Enabled: true, Directories: []Directory{{Path: project, Access: "rw"}}, Network: []NetworkEndpoint{{Scheme: "https", Host: "registry.example.com", Port: 443}}}
	first, err := s.PutGrant(in)
	if err != nil || first.Revision != 1 {
		t.Fatalf("授权：%+v %v", first, err)
	}
	in.ID, in.ExpectedRevision, in.Directories[0].Access = first.ID, 1, "ro"
	second, err := s.PutGrant(in)
	if err != nil || second.Revision != 2 {
		t.Fatalf("授权更新：%+v %v", second, err)
	}
	old, err := s.GetGrant(first.ID, 1, false)
	if err != nil || old.Directories[0].Access != "rw" {
		t.Fatalf("旧授权变化：%+v %v", old, err)
	}
	for _, badPath := range []string{opts.MountRoot, filepath.Dir(opts.MountRoot), opts.MountRoot + "-other/project", filepath.Join(opts.MountRoot, "missing")} {
		bad := GrantInput{Name: "错误授权", Enabled: true, Directories: []Directory{{Path: badPath, Access: "rw"}}}
		if _, err = s.PutGrant(bad); err == nil {
			t.Errorf("接受越界或不存在的目录：%s", badPath)
		}
	}
	if err = os.Rename(project, project+"-original"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(project+"-original", project); err != nil {
		t.Fatal(err)
	}
	_, err = s.GetGrant(first.ID, 1, false)
	requireErrorCode(t, err, "execution_unsafe_directory")
	// 历史仍可解释，目录变化不使整个配置无法打开；执行前必须重新核对。
	reopened, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err = reopened.GetGrant(first.ID, 1, true); err != nil {
		t.Fatal(err)
	}
	if _, err = reopened.SetGrantEnabled(first.ID, 2, false); err != nil {
		t.Fatalf("应允许撤销已丢失目录：%v", err)
	}
	_, err = s.GetGrant(first.ID, 1, false)
	requireErrorCode(t, err, "execution_grant_disabled")
}

func TestConfigNetworkExactEndpointsAndPrivateCIDR(t *testing.T) {
	s, _, _ := openTestStore(t)
	endpoint := NetworkEndpoint{Scheme: "https", Host: "service.example.com", Port: 443}
	in := GrantInput{Name: "网络", Enabled: true, Network: []NetworkEndpoint{endpoint}}
	grant, err := s.PutGrant(in)
	if err != nil {
		t.Fatal(err)
	}
	if err = CheckNetworkAddress(grant, endpoint, netip.MustParseAddr("93.184.215.14")); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"127.0.0.1", "::1", "169.254.169.254", "fe80::1", "100.100.100.200", "fd00:ec2::254", "0.0.0.0", "224.0.0.1", "10.1.2.3", "::ffff:127.0.0.1"} {
		if err = CheckNetworkAddress(grant, endpoint, netip.MustParseAddr(raw)); err == nil {
			t.Errorf("接受受限地址 %s", raw)
		}
	}
	wrong := endpoint
	wrong.Port = 80
	if err = CheckNetworkAddress(grant, wrong, netip.MustParseAddr("93.184.215.14")); err == nil {
		t.Fatal("忽略精确端口")
	}
	in.PrivateCIDRs = []string{"10.1.0.0/16"}
	private, err := s.PutGrant(in)
	if err != nil {
		t.Fatal(err)
	}
	if err = CheckNetworkAddress(private, endpoint, netip.MustParseAddr("10.1.2.3")); err != nil {
		t.Fatal(err)
	}
	if err = CheckNetworkAddress(private, endpoint, netip.MustParseAddr("10.2.2.3")); err == nil {
		t.Fatal("私网越界")
	}
	for _, raw := range []string{"0.0.0.0/0", "127.0.0.0/8", "169.254.0.0/16", "8.8.8.0/24", "10.1.2.3/16", "fc00::/7", "fd00:ec2::/64"} {
		in.PrivateCIDRs = []string{raw}
		if _, err = s.PutGrant(in); err == nil {
			t.Errorf("接受非法私网CIDR %s", raw)
		}
	}
	for _, host := range []string{"*.example.com", "localhost", "metadata.google.internal", "127.0.0.1", "example.com/path", "example.com.", "example.com:443"} {
		in.PrivateCIDRs = nil
		in.Network = []NetworkEndpoint{{Scheme: "https", Host: host, Port: 443}}
		if _, err = s.PutGrant(in); err == nil {
			t.Errorf("接受非法精确域名 %s", host)
		}
	}
}

func TestConfigUnsafeFileAndParent(t *testing.T) {
	s, path, opts := openTestStore(t)
	if _, err := s.PutProfile(profileInput()); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	original := path + ".original"
	if err := os.Rename(path, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(original, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path, opts); err == nil {
		t.Fatal("接受配置符号链接")
	}
	os.Remove(path)
	if err := os.Link(original, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path, opts); err == nil {
		t.Fatal("接受配置硬链接")
	}
	parent := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(filepath.Dir(path), parent); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(filepath.Join(parent, "other.json"), opts); err == nil {
		t.Fatal("接受配置父目录链接")
	}
}
