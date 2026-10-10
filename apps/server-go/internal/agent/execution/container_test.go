package execution

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "agent-exec-supervisor" {
		if ServeSupervisor(context.Background(), os.Stdin, os.Stdout) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// 显式指定已有本地镜像才运行；本测试从不拉取镜像，也不使用真实模型或凭据。
func TestRealContainerExecution(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("设置已有本地 Python 镜像完整摘要后运行真实容器验收")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	e, err := New(Options{SocketPath: "/var/run/docker.sock", SupervisorPath: binary, MountRoot: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := e.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	profile := testProfile()
	profile.Image = image
	script := `import os, pathlib, socket, subprocess, sys
assert os.getuid() == 65532
assert not pathlib.Path('/var/run/docker.sock').exists()
assert '127.0.0.1' in os.environ['HTTPS_PROXY']
assert pathlib.Path('input.txt').read_text() == 'input'
try:
    socket.create_connection(('1.1.1.1', 443), timeout=0.2)
    raise AssertionError('unexpected network')
except OSError:
    pass
pathlib.Path('output.txt').write_text('isolated')
subprocess.Popen([sys.executable, '-c', "import time,pathlib; time.sleep(2); pathlib.Path('/workspace/escaped.txt').write_text('bad')"], start_new_session=True)
print('容器隔离已验证')
`
	var output bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := e.RunScript(ctx, ScriptRequest{ID: "real-execution-test", Profile: profile, ScriptPath: "scripts/check.py", SkillArchive: bytes.NewReader(testTar("scripts/check.py", script)), WorkspaceArchive: bytes.NewReader(testTar("input.txt", "input")), WorkspaceOutput: &output})
	if err != nil {
		t.Fatalf("real execution: %v, result=%+v", err, result)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "容器隔离已验证") {
		t.Fatalf("result=%+v", result)
	}
	files := map[string]string{}
	reader := tar.NewReader(bytes.NewReader(output.Bytes()))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		files[header.Name] = string(raw)
	}
	if files["output.txt"] != "isolated" || files["input.txt"] != "input" || files["escaped.txt"] != "" {
		t.Fatalf("unexpected workspace %#v", files)
	}
}

func TestRealContainerRestrictedProxy(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("设置已有本地 Python 镜像完整摘要后运行真实代理验收")
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "http://forbidden.example.com/", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "authorized response")
	}))
	defer origin.Close()
	tlsOrigin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "authorized tls") }))
	defer tlsOrigin.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	e, err := New(Options{SocketPath: "/var/run/docker.sock", SupervisorPath: binary, MountRoot: "/tmp", LookupIP: func(_ context.Context, host string) ([]net.IPAddr, error) {
		if host != "service.example.com" {
			t.Errorf("unexpected DNS %s", host)
		}
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "8.8.8.8:443" {
			return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(tlsOrigin.URL, "https://"))
		}
		if address != "8.8.8.8:80" {
			t.Errorf("unexpected address %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(origin.URL, "http://"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close(context.Background())
	profile := testProfile()
	profile.Image = image
	grant := &config.Grant{Name: "代理验收", Enabled: true, Network: []config.NetworkEndpoint{{Scheme: "http", Host: "service.example.com", Port: 80}, {Scheme: "https", Host: "service.example.com", Port: 443}}}
	script := `import urllib.request, urllib.error, ssl
assert urllib.request.urlopen('http://service.example.com/', timeout=5).read() == b'authorized response'
assert urllib.request.urlopen('https://service.example.com/', timeout=5, context=ssl._create_unverified_context()).read() == b'authorized tls'
try:
    urllib.request.urlopen('http://service.example.com/redirect', timeout=5)
    raise AssertionError('unexpected redirect permission')
except urllib.error.HTTPError as err:
    assert err.code == 403
print('代理目标边界已验证')
`
	var output bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := e.RunScript(ctx, ScriptRequest{ID: "real-proxy-test", Profile: profile, Grant: grant, ScriptPath: "scripts/proxy.py", SkillArchive: bytes.NewReader(testTar("scripts/proxy.py", script)), WorkspaceOutput: &output})
	if err != nil || result.ExitCode != 0 || !strings.Contains(result.Stdout, "代理目标边界已验证") {
		t.Fatalf("proxy err=%v result=%+v", err, result)
	}
}

func TestRealStdioGrantAndIndependentLifetime(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("设置已有本地 Python 镜像完整摘要后运行真实 stdio 验收")
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "stdio authorized") }))
	defer origin.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	grant := &config.Grant{ID: "grant-" + strings.Repeat("a", 32), Revision: 1, Name: "stdio授权", Enabled: true, Network: []config.NetworkEndpoint{{Scheme: "http", Host: "service.example.com", Port: 80}}}
	e, err := New(Options{SocketPath: "/var/run/docker.sock", SupervisorPath: binary, MountRoot: "/tmp", ResolveGrant: func(id string, revision int) (*config.Grant, error) {
		if id != grant.ID || revision != 1 {
			t.Error("未固定授权修订")
		}
		return grant, nil
	}, LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(origin.URL, "http://"))
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close(context.Background())
	startup, cancel := context.WithCancel(context.Background())
	process, err := e.Open(startup, mcp.Server{ID: "stdio-grant-test", Revision: 1, Stdio: &mcp.ContainerSpec{Image: image, GrantID: grant.ID, GrantRevision: 1, Command: []string{"python3", "-u", "-c", `import os,sys,urllib.request
assert os.getcwd() == '/tmp'
assert not os.path.exists('/workspace')
for line in sys.stdin:
    print(urllib.request.urlopen('http://service.example.com/',timeout=5).read().decode(),flush=True)
`}}})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()
	readDone := make(chan string, 1)
	go func() {
		var raw [17]byte
		_, err := io.ReadFull(process.Stdout(), raw[:])
		if err != nil {
			readDone <- err.Error()
			return
		}
		readDone <- string(raw[:])
	}()
	go io.Copy(io.Discard, process.Stderr())
	if _, err = io.WriteString(process.Stdin(), "query\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-readDone:
		if got != "stdio authorized\n" {
			t.Fatalf("stdio=%q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stdio request timed out")
	}
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if err = e.RevokeGrant(ctx, grant.ID, grant.Revision); err != nil {
		t.Fatal(err)
	}
}
