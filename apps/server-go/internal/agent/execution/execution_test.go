package execution

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/execution/config"
)

type fakeEngine struct {
	mu           sync.Mutex
	creates      []map[string]any
	labels       map[string]map[string]string
	volumes      map[string]map[string]string
	started      []string
	archiveNames []string
	retain       bool
	hang         bool
	protocol     func(frame) []frame
	connections  []net.Conn
}

func newFakeExecutor(t *testing.T) (*Executor, *fakeEngine) {
	t.Helper()
	root := t.TempDir()
	socket := filepath.Join(root, "engine.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeEngine{labels: make(map[string]map[string]string), volumes: make(map[string]map[string]string)}
	server := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go server.Serve(listener)
	binaryPath := filepath.Join(root, "supervisor")
	if err = os.WriteFile(binaryPath, []byte("\x7fELF-test"), 0700); err != nil {
		t.Fatal(err)
	}
	e, err := New(Options{SocketPath: socket, SupervisorPath: binaryPath, MountRoot: root, Authorize: func(context.Context, string) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = e.Close(ctx)
		f.mu.Lock()
		for _, c := range f.connections {
			c.Close()
		}
		f.mu.Unlock()
		server.Close()
	})
	return e, f
}
func (f *fakeEngine) serve(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v1.41")
	if strings.HasPrefix(path, "/images/") {
		_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Config": map[string]any{}})
		return
	}
	if path == "/containers/json" {
		f.mu.Lock()
		items := []map[string]any{}
		for id, labels := range f.labels {
			items = append(items, map[string]any{"Id": id, "Labels": labels})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(items)
		return
	}
	if path == "/volumes" {
		f.mu.Lock()
		items := []map[string]any{}
		for name, labels := range f.volumes {
			items = append(items, map[string]any{"Name": name, "Labels": labels})
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"Volumes": items})
		return
	}
	if path == "/volumes/create" && r.Method == "POST" {
		var body struct {
			Name   string
			Labels map[string]string
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.volumes[body.Name] = body.Labels
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"Name": body.Name})
		return
	}
	if strings.HasPrefix(path, "/volumes/") {
		name := strings.TrimPrefix(path, "/volumes/")
		f.mu.Lock()
		labels, ok := f.volumes[name]
		if r.Method == "DELETE" {
			delete(f.volumes, name)
		}
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Name": name, "Labels": labels})
		return
	}
	if path == "/containers/create" {
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.creates = append(f.creates, body)
		id := fmt.Sprintf("%064x", len(f.creates))
		labels := map[string]string{}
		for k, v := range body["Labels"].(map[string]any) {
			labels[k] = v.(string)
		}
		f.labels[id] = labels
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": id})
		return
	}
	if !strings.HasPrefix(path, "/containers/") {
		w.WriteHeader(404)
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "/containers/"), "/")
	id := parts[0]
	f.mu.Lock()
	labels, exists := f.labels[id]
	f.mu.Unlock()
	if !exists {
		w.WriteHeader(404)
		return
	}
	if len(parts) == 1 && r.Method == "DELETE" {
		f.mu.Lock()
		if !f.retain || len(f.started) == 0 {
			delete(f.labels, id)
		}
		f.mu.Unlock()
		w.WriteHeader(204)
		return
	}
	if len(parts) < 2 {
		w.WriteHeader(404)
		return
	}
	switch parts[1] {
	case "json":
		_ = json.NewEncoder(w).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}, "State": map[string]bool{"Running": false}})
	case "archive":
		if r.URL.Query().Get("path") != "/bundle" {
			w.WriteHeader(400)
			return
		}
		tr := tar.NewReader(r.Body)
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				w.WriteHeader(400)
				return
			}
			f.mu.Lock()
			f.archiveNames = append(f.archiveNames, h.Name)
			f.mu.Unlock()
			_, _ = io.Copy(io.Discard, tr)
		}
		w.WriteHeader(200)
	case "start":
		f.mu.Lock()
		f.started = append(f.started, id)
		f.mu.Unlock()
		w.WriteHeader(204)
	case "attach":
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = rw.Flush()
		f.mu.Lock()
		f.connections = append(f.connections, conn)
		hang := f.hang
		protocol := f.protocol
		f.mu.Unlock()
		go func() {
			defer conn.Close()
			scanner := bufio.NewScanner(rw)
			for scanner.Scan() {
				var start frame
				if json.Unmarshal(scanner.Bytes(), &start) != nil {
					return
				}
				if start.Kind != "start" {
					continue
				}
				if hang {
					_, _ = io.Copy(io.Discard, conn)
					return
				}
				frames := []frame{{Kind: "stdout", Data: []byte("运行成功\n")}, {Kind: "stderr", Data: []byte("诊断\n")}}
				if start.Mode == "script" {
					frames = append(frames, frame{Kind: "workspace", Data: testTar("result.txt", "done")})
				}
				frames = append(frames, frame{Kind: "exit", ExitCode: 0})
				if protocol != nil {
					frames = protocol(start)
				}
				for _, frame := range frames {
					raw, _ := json.Marshal(frame)
					raw = append(raw, '\n')
					var header [8]byte
					header[0] = 1
					binary.BigEndian.PutUint32(header[4:], uint32(len(raw)))
					if _, err = conn.Write(header[:]); err != nil {
						return
					}
					if _, err = conn.Write(raw); err != nil {
						return
					}
				}
				return
			}
		}()
	default:
		w.WriteHeader(404)
	}
}
func testTar(name, content string) []byte {
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Typeflag: tar.TypeReg, Size: int64(len(content))})
	_, _ = tw.Write([]byte(content))
	_ = tw.Close()
	return b.Bytes()
}
func testProfile() config.Profile {
	return config.Profile{Name: "测试运行时", Image: "python@sha256:" + strings.Repeat("a", 64), Runtime: "python", Command: []string{"python3"}, Enabled: true, TimeoutSeconds: 30, CPUMillis: 1000, MemoryBytes: 512 << 20, PIDs: 128}
}

func bashProfile() config.Profile {
	p := testProfile()
	p.Runtime = "bash"
	p.Command = []string{"bash", "--noprofile", "--norc"}
	return p
}

func TestBashCommandKeepsFixedEntrypointAndWorkspaceIsolation(t *testing.T) {
	e, f := newFakeExecutor(t)
	var started frame
	f.protocol = func(start frame) []frame {
		started = start
		return []frame{{Kind: "stdout", Data: []byte("ok\n")}, {Kind: "exit", ExitCode: 0}}
	}
	var output bytes.Buffer
	result, err := e.RunCommand(context.Background(), CommandRequest{
		ID:               "bash-command",
		Profile:          bashProfile(),
		Command:          "rm -f input.txt; printf ok",
		WorkspaceArchive: bytes.NewReader(testTar("input.txt", "input")),
		WorkspaceOutput:  &output,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Stdout != "ok\n" {
		t.Fatalf("result=%+v", result)
	}
	if started.Mode != "script" || !reflect.DeepEqual(started.Command, []string{"bash", "--noprofile", "--norc", "-c", "rm -f input.txt; printf ok", "elysian-command"}) {
		t.Fatalf("command escaped profile entrypoint: %#v", started.Command)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != 2 || len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatalf("lifecycle creates=%d containers=%d volumes=%d", len(f.creates), len(f.labels), len(f.volumes))
	}
	host := f.creates[1]["HostConfig"].(map[string]any)
	if host["NetworkMode"] != "none" || host["ReadonlyRootfs"] != true {
		t.Fatalf("unsafe command container: %#v", host)
	}
}

func TestWorkspaceScriptRejectsTraversalBeforeContainer(t *testing.T) {
	e, f := newFakeExecutor(t)
	var output bytes.Buffer
	_, err := e.RunWorkspaceScript(context.Background(), WorkspaceScriptRequest{
		ID:               "workspace-script",
		Profile:          bashProfile(),
		ScriptPath:       "../outside.sh",
		WorkspaceArchive: bytes.NewReader(testTar("run.sh", "echo ok")),
		WorkspaceOutput:  &output,
	})
	if err == nil {
		t.Fatal("workspace traversal accepted")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != 0 || len(f.volumes) != 0 {
		t.Fatal("unsafe workspace script created execution resources")
	}
}
func TestScriptContainerPoliciesAndCopyOut(t *testing.T) {
	e, f := newFakeExecutor(t)
	var output bytes.Buffer
	result, err := e.RunScript(context.Background(), ScriptRequest{ID: "run-test", Profile: testProfile(), ScriptPath: "scripts/main.py", SkillArchive: bytes.NewReader(testTar("scripts/main.py", "print('ok')")), WorkspaceArchive: bytes.NewReader(testTar("input.txt", "test")), WorkspaceOutput: &output})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Stdout != "运行成功\n" || result.Stderr != "诊断\n" || result.WorkspaceBytes != int64(output.Len()) {
		t.Fatalf("result=%+v", result)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != 2 || len(f.started) != 1 || len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatalf("lifecycle creates=%d starts=%d containers=%d volumes=%d", len(f.creates), len(f.started), len(f.labels), len(f.volumes))
	}
	for i, body := range f.creates {
		host := body["HostConfig"].(map[string]any)
		if host["NetworkMode"] != "none" || host["ReadonlyRootfs"] != true || body["User"] != "65532:65532" || host["Memory"] != float64(512<<20) || host["NanoCpus"] != float64(1000000000) || host["PidsLimit"] != float64(128) {
			t.Fatalf("unsafe create %#v", body)
		}
		mount := host["Mounts"].([]any)[0].(map[string]any)
		if mount["ReadOnly"] != (i == 1) {
			t.Fatalf("mount=%#v", mount)
		}
		if _, ok := body["Env"]; i == 1 && !ok {
			t.Fatal("missing bounded environment")
		}
	}
	if strings.Contains(fmt.Sprint(f.creates), "docker.sock") {
		t.Fatal("docker socket exposed")
	}
}
func TestUnconfirmedDeletionNeverSucceeds(t *testing.T) {
	e, f := newFakeExecutor(t)
	f.retain = true
	var out bytes.Buffer
	_, err := e.RunScript(context.Background(), ScriptRequest{ID: "run-unknown", Profile: testProfile(), ScriptPath: "scripts/main.py", SkillArchive: bytes.NewReader(testTar("scripts/main.py", "pass")), WorkspaceOutput: &out})
	var known *Error
	if !errors.As(err, &known) || !known.OutcomeUnknown || known.Code != "execution-stop-unconfirmed" {
		t.Fatalf("err=%v", err)
	}
}
func TestCancellationStopsContainer(t *testing.T) {
	e, f := newFakeExecutor(t)
	f.hang = true
	ctx, cancel := context.WithCancel(context.Background())
	p, err := e.OpenStdio(ctx, StdioRequest{ID: "mcp-test", Profile: testProfile(), Command: []string{"python3", "-u", "server.py"}})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if p.ctx.Err() != nil {
		t.Fatal("短启动上下文取消不应终止已建立的 stdio 连接")
	}
	stopCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	if err = p.Close(stopCtx); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatal("cancellation left containers")
	}
}

func TestScriptTimeoutIsUnknownAndStopsContainer(t *testing.T) {
	e, f := newFakeExecutor(t)
	f.hang = true
	profile := testProfile()
	profile.TimeoutSeconds = 1
	var out bytes.Buffer
	_, err := e.RunScript(context.Background(), ScriptRequest{ID: "timeout-test", Profile: profile, ScriptPath: "scripts/main.py", SkillArchive: bytes.NewReader(testTar("scripts/main.py", "pass")), WorkspaceOutput: &out})
	var known *Error
	if !errors.As(err, &known) || !known.OutcomeUnknown || known.Code != "execution-timeout" {
		t.Fatalf("timeout err=%v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatal("timeout left resources")
	}
}

func TestStdioRevocationUsesExactServerRevision(t *testing.T) {
	e, f := newFakeExecutor(t)
	f.hang = true
	request := StdioRequest{ID: "server-run", ServerID: "mcp-fixed", ServerRevision: 2, Profile: testProfile(), Command: []string{"python3", "server.py"}}
	p, err := e.OpenStdio(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.RevokeServer(context.Background(), request.ServerID, 1); err != nil {
		t.Fatal(err)
	}
	if p.ctx.Err() != nil {
		t.Fatal("撤销其他修订影响当前连接")
	}
	if err = e.RevokeServer(context.Background(), request.ServerID, 2); err != nil {
		t.Fatal(err)
	}
	if p.ctx.Err() == nil {
		t.Fatal("匹配修订未关闭")
	}
	f.mu.Lock()
	count := len(f.creates)
	f.mu.Unlock()
	if _, err = e.OpenStdio(context.Background(), request); err == nil {
		t.Fatal("撤销后可重开旧连接")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.creates) != count {
		t.Fatal("被撤销连接仍创建了容器")
	}
}
func TestUnsafeArchiveCannotStart(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "dir/../../x", "a\\b"} {
		t.Run(name, func(t *testing.T) {
			e, f := newFakeExecutor(t)
			var out bytes.Buffer
			_, err := e.RunScript(context.Background(), ScriptRequest{ID: "unsafe-test", Profile: testProfile(), ScriptPath: "scripts/main.py", SkillArchive: bytes.NewReader(testTar(name, "bad")), WorkspaceOutput: &out})
			if err == nil {
				t.Fatal("unsafe archive accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.started) != 0 || len(f.labels) != 0 || len(f.volumes) != 0 {
				t.Fatal("unsafe archive ran or leaked")
			}
		})
	}
}
func TestTargetDNSPinnedAndPrivateGrant(t *testing.T) {
	e, _ := newFakeExecutor(t)
	endpoint := config.NetworkEndpoint{Scheme: "https", Host: "service.example.com", Port: 443}
	grant := &config.Grant{Name: "网络", Enabled: true, Network: []config.NetworkEndpoint{endpoint}}
	e.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	}
	dialed := false
	e.options.DialContext = func(context.Context, string, string) (net.Conn, error) { dialed = true; return nil, errors.New("test") }
	if _, err := e.dialTarget(context.Background(), grant, "https", endpoint.Host, 443); err == nil || dialed {
		t.Fatal("mixed public/loopback DNS accepted")
	}
	e.options.LookupIP = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("10.42.1.2")}}, nil
	}
	if _, err := e.dialTarget(context.Background(), grant, "https", endpoint.Host, 443); err == nil || dialed {
		t.Fatal("private address accepted without CIDR")
	}
	grant.PrivateCIDRs = []string{"10.42.0.0/16"}
	e.options.DialContext = func(_ context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "10.42.1.2:443" {
			t.Fatalf("unfixed dial %s %s", network, address)
		}
		left, right := net.Pipe()
		right.Close()
		return left, nil
	}
	conn, err := e.dialTarget(context.Background(), grant, "https", endpoint.Host, 443)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
func TestWorkspaceExportRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "leak")); err != nil {
		t.Fatal(err)
	}
	if err := writeWorkspace(context.Background(), root, io.Discard); err == nil {
		t.Fatal("linked workspace exported")
	}
}
func TestSupervisorRejectsHostProcess(t *testing.T) {
	if os.Getpid() == 1 {
		t.Skip("test itself is PID1")
	}
	if ServeSupervisor(context.Background(), strings.NewReader(""), io.Discard) == nil {
		t.Fatal("supervisor accepted host process")
	}
}

func TestStartupRecoveryOnlyOwnedObjects(t *testing.T) {
	e, f := newFakeExecutor(t)
	labels := map[string]string{"elysian.agent.execution": "true", "elysian.agent.execution.id": "old-run"}
	f.labels[strings.Repeat("b", 64)] = labels
	f.volumes["elysian-agent-"+strings.Repeat("c", 32)] = labels
	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.labels) != 0 || len(f.volumes) != 0 {
		t.Fatal("recovery left old execution state")
	}
}
