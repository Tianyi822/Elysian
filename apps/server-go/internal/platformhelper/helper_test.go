package platformhelper

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEnvironmentPreservesQuotedContentAndRejectsAmbiguity(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "environment")
	output := filepath.Join(dir, "candidate")
	preserved := "OTHER=\"first\nELYSIAN_CADDY_SOCKET=embedded\nlast\"\n# keep\n"
	if err := os.WriteFile(input, []byte(preserved+"ELYSIAN_CADDY_SOCKET='/old/admin.sock'\n"), 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := Run([]string{"env-write", input, "/run/caddy/new.sock", output}); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(output)
	if string(body) != preserved+"ELYSIAN_CADDY_SOCKET=/run/caddy/new.sock\n" {
		t.Fatal(string(body))
	}
	value, err := Run([]string{"env-read", output})
	if err != nil || value != "/run/caddy/new.sock" {
		t.Fatalf("%q %v", value, err)
	}
	for _, content := range []string{"OTHER=\"unfinished", "OTHER=continued\\\n", "ELYSIAN_CADDY_SOCKET=/bad/../path\n"} {
		os.WriteFile(input, []byte(content), 0600)
		if _, err := Run([]string{"env-write", input, "/run/new.sock", output}); err == nil {
			t.Fatalf("accepted %q", content)
		}
	}
}

func TestCaddyComparisonsPreserveRoutesAndNormalizeOnlySourceFile(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	out := filepath.Join(dir, "out")
	write := func(file, body string) {
		t.Helper()
		if err := os.WriteFile(file, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(a, `{"apps":{"http":{"servers":{"site":{"routes":[{"handler":"file_server","hide":["/original","/private"]}]}}}}}`)
	write(b, `{"apps":{"http":{"servers":{"site":{"routes":[{"handler":"file_server","hide":["/temporary","/private"]}]}}}}}`)
	if _, err := Run([]string{"equal-caddyfile", a, b, "/original", "/temporary"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Run([]string{"equal", a, b}); err == nil {
		t.Fatal("changed route accepted")
	}
	if _, err := Run([]string{"connect", a, "/run/caddy/admin.sock", out}); err != nil {
		t.Fatal(err)
	}
	if value, err := Run([]string{"endpoint", out}); err != nil || value != "unix:/run/caddy/admin.sock" {
		t.Fatalf("%s %v", value, err)
	}
	for _, body := range []string{`{"admin":{"disabled":true}}`, `{"admin":{"disabled":"true"}}`, `{"admin":{"listen":"0.0.0.0:2019"}}`, `[]`, `false`, `{`} {
		write(b, body)
		if _, err := Run([]string{"endpoint", b}); err == nil {
			t.Fatal("unsafe endpoint accepted", body)
		}
	}
	write(b, strings.Repeat(" ", maximumConfigBytes+1))
	if _, err := Run([]string{"validate", b}); err == nil {
		t.Fatal("oversized config accepted")
	}
}

func TestServiceAndSocketBoundaries(t *testing.T) {
	for _, path := range []string{"relative.sock", "/tmp/../root.sock", "/run/a b.sock", "/run/a\nsock"} {
		if _, err := Run([]string{"socket", path}); err == nil {
			t.Fatal(path)
		}
	}
	value := "{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; }"
	if _, err := Run([]string{"service", value, "/etc/caddy/Caddyfile"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Run([]string{"service", strings.Replace(value, "run --environ", "run --watch", 1), "/etc/caddy/Caddyfile"}); err == nil {
		t.Fatal("custom service accepted")
	}
	dir := t.TempDir()
	socket := filepath.Join(dir, "admin.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	if err := removeStaleSocket(socket); err == nil {
		t.Fatal("active socket removed")
	}
	listener.Close()
	if os.Getuid() == 0 {
		if err := removeStaleSocket(socket); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Lstat(socket); !os.IsNotExist(err) {
			t.Fatal("stale socket retained")
		}
	}
	link := filepath.Join(dir, "link")
	os.Symlink(dir, link)
	if err := removeStaleSocket(filepath.Join(link, "missing.sock")); err == nil {
		t.Fatal("symlink ancestor accepted")
	}
}

func TestWaitUsesTotalDeadlineAndSemanticJSON(t *testing.T) {
	dir := t.TempDir()
	expected := filepath.Join(dir, "expected")
	output := filepath.Join(dir, "output")
	os.WriteFile(expected, []byte(`{"a":1,"b":2}`), 0600)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"b":2,"a":1}`)) }))
	defer server.Close()
	if err := waitForCaddy([]string{"tcp:" + strings.TrimPrefix(server.URL, "http://"), output, expected, "1", "0", "1"}); err != nil {
		t.Fatal(err)
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.Write([]byte(`{}`))
	}))
	defer slow.Close()
	started := time.Now()
	if err := waitForCaddy([]string{"tcp:" + strings.TrimPrefix(slow.URL, "http://"), output, "", "100", "0.1", "0.05"}); err == nil {
		t.Fatal("late response accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("total deadline exceeded")
	}
}
