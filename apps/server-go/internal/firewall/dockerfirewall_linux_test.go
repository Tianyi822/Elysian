package firewall

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Run only in a disposable Linux container with --network none, NET_ADMIN,
// SYS_ADMIN and both forwarding sysctls set to 1. No Docker socket is needed.
func TestDockerFirewallKernel(t *testing.T) {
	if os.Getenv("ELYSIAN_TEST_DOCKER_FIREWALL_NETNS") != "1" {
		t.Skip("requires an isolated Linux router network namespace")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	run := func(bin string, args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v: %s", bin, args, err, out)
		}
		return string(out)
	}
	if links := run("ip", "-o", "link", "show", "up"); !strings.HasPrefix(links, "1: lo:") || strings.Count(links, "\n") != 1 {
		t.Fatal("refusing to modify a network namespace with active non-loopback interfaces")
	}
	start := func(bin string, args ...string) *exec.Cmd {
		t.Helper()
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Stderr = os.Stderr
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		})
		if line, err := bufio.NewReader(out).ReadString('\n'); line != "ready\n" || err != nil {
			t.Fatalf("%s did not start: %q %v", bin, line, err)
		}
		return cmd
	}
	namespace := func(host, peer string, addresses [4]string) string {
		t.Helper()
		owner := start("unshare", "-n", "sh", "-c", "echo ready; exec sleep 90")
		pid := strconv.Itoa(owner.Process.Pid)
		run("ip", "link", "add", host, "type", "veth", "peer", "name", peer)
		run("ip", "link", "set", peer, "netns", pid)
		run("ip", "addr", "add", addresses[0], "dev", host)
		run("ip", "-6", "addr", "add", addresses[1], "dev", host, "nodad")
		run("ip", "link", "set", host, "up")
		run("nsenter", "-t", pid, "-n", "ip", "addr", "add", addresses[2], "dev", peer)
		run("nsenter", "-t", pid, "-n", "ip", "-6", "addr", "add", addresses[3], "dev", peer, "nodad")
		run("nsenter", "-t", pid, "-n", "ip", "link", "set", peer, "up")
		run("nsenter", "-t", pid, "-n", "ip", "link", "set", "lo", "up")
		for i, addressFamily := range []string{"-4", "-6"} {
			gateway, _, _ := strings.Cut(addresses[i], "/")
			run("nsenter", "-t", pid, "-n", "ip", addressFamily, "route", "add", "default", "via", gateway)
		}
		return pid
	}
	client := namespace("testwan", "client0", [4]string{"192.0.2.1/24", "2001:db8:1::1/64", "192.0.2.2/24", "2001:db8:1::2/64"})
	server := namespace("testlan", "backend0", [4]string{"198.51.100.1/24", "2001:db8:2::1/64", "198.51.100.2/24", "2001:db8:2::2/64"})
	run("nsenter", "-t", client, "-n", "ip", "addr", "add", "192.0.2.3/24", "dev", "client0")
	run("nsenter", "-t", server, "-n", "ip", "addr", "add", "198.51.100.3/24", "dev", "backend0")
	start("nsenter", "-t", server, "-n", "python3", "-u", "-c", `
import socket, select
sockets = []
for family, bind in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "2001:db8:2::2")):
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        sock = socket.socket(family, kind)
        if family == socket.AF_INET6:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock.bind((bind, 8080))
        if kind == socket.SOCK_STREAM:
            sock.listen()
        sockets.append(sock)
print("ready")
while True:
    for sock in select.select(sockets, [], [])[0]:
        if sock.type == socket.SOCK_STREAM:
            peer, _ = sock.accept()
            peer.sendall(b"ok")
            peer.close()
        else:
            data, peer = sock.recvfrom(10)
            sock.sendto(b"ok", peer)
`)
	isOpen := func(family, source, protocol, port string) bool {
		t.Helper()
		dest := "192.0.2.1"
		if family == "6" {
			dest = "2001:db8:1::1"
		}
		out, err := exec.CommandContext(ctx, "nsenter", "-t", client, "-n", "python3", "-c", `
import socket, sys
family, source, dest, proto, port = sys.argv[1:]
s = socket.socket(socket.AF_INET6 if family == "6" else socket.AF_INET,
                  socket.SOCK_DGRAM if proto == "udp" else socket.SOCK_STREAM)
s.settimeout(1.2)
s.bind((source, 0))
try:
    s.connect((dest, int(port)))
    if proto == "udp":
        s.send(b"probe")
    assert s.recv(2) == b"ok"
except (TimeoutError, ConnectionRefusedError):
    sys.exit(42)
`, family, source, dest, protocol, port).CombinedOutput()
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 42 {
			return false
		}
		if err != nil {
			t.Fatalf("external probe: %v %s", err, out)
		}
		return true
	}
	d := newDockerFirewall()
	for _, family := range d.families() {
		run(family, "-N", "DOCKER-USER")
		run(family, "-A", "DOCKER-USER", "-j", "RETURN")
		run(family, "-A", "FORWARD", "-j", "DOCKER-USER")
		run(family, "-A", "FORWARD", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT")
		run(family, "-A", "FORWARD", "-o", "testlan", "-m", "conntrack", "--ctstate", "DNAT", "-j", "ACCEPT")
		run(family, "-P", "FORWARD", "DROP")
		run(family, "-t", "nat", "-N", "DOCKER")
		run(family, "-t", "nat", "-A", "PREROUTING", "-i", "testwan", "-j", "DOCKER")
		target := "198.51.100.2:8080"
		if family == "ip6tables" {
			target = "[2001:db8:2::2]:8080"
		}
		for _, binding := range [][2]string{{"tcp", "12080"}, {"tcp", "12081"}, {"tcp", "12082"}, {"udp", "13478"}} {
			run(family, "-t", "nat", "-A", "DOCKER", "-p", binding[0], "--dport", binding[1], "-j", "DNAT", "--to-destination", target)
		}
	}
	open4 := isOpen("4", "192.0.2.3", "tcp", "12081")
	open6 := isOpen("6", "2001:db8:1::2", "udp", "13478")
	// A cold neighbor cache in a fresh namespace may delay the first IPv6
	// packet past the probe deadline. Warm the paths only before enforcement.
	if !open6 {
		open6 = isOpen("6", "2001:db8:1::2", "udp", "13478")
	}
	open6TCP := isOpen("6", "2001:db8:1::2", "tcp", "12081")
	if !open4 || !open6TCP || !open6 {
		for _, binary := range d.families() {
			t.Log(run(binary, "-nvL", "FORWARD"), run(binary, "-t", "nat", "-nvL", "DOCKER"))
		}
		t.Log(run("nsenter", "-t", server, "-n", "ip", "-6", "route", "show"), run("nsenter", "-t", server, "-n", "ip", "-6", "neigh", "show"))
		t.Fatal("fixture did not reproduce published ports bypassing INPUT", open4, open6TCP, open6)
	}
	run("ufw", "allow", "proto", "tcp", "from", "192.0.2.2", "to", "192.0.2.1", "port", "12080")
	run("ufw", "allow", "proto", "tcp", "from", "2001:db8:1::2", "to", "2001:db8:1::1", "port", "12080")
	run("ufw", "prepend", "deny", "proto", "tcp", "from", "192.0.2.3", "to", "any", "port", "12080")
	run("ufw", "allow", "13478/udp")
	run("ufw", "limit", "12082/tcp")
	beforeV4, err := os.ReadFile(defaultFirewallPaths.BeforeRules)
	if err != nil {
		t.Fatal(err)
	}
	d.read = func(path string) ([]byte, error) {
		switch path {
		case defaultFirewallPaths.UfwConf:
			return []byte("ENABLED=yes\n"), nil
		case defaultFirewallPaths.BeforeRules:
			return beforeV4, nil
		}
		return os.ReadFile(path)
	}
	syncPolicy := func() {
		t.Helper()
		if err := d.reconcile(ctx, false); err != nil {
			t.Fatal(err)
		}
	}
	syncPolicy()
	if !isOpen("4", "192.0.2.2", "tcp", "12080") || isOpen("4", "192.0.2.3", "tcp", "12080") ||
		isOpen("4", "192.0.2.2", "tcp", "12081") || !isOpen("6", "2001:db8:1::2", "tcp", "12080") ||
		isOpen("6", "2001:db8:1::2", "tcp", "12081") || !isOpen("6", "2001:db8:1::2", "udp", "13478") {
		t.Fatal("Docker forwarding verdict disagrees with the saved UFW input rules")
	}
	run("iptables", "-t", "nat", "-R", "DOCKER", "1", "-p", "tcp", "--dport", "12080", "-j", "DNAT", "--to-destination", "198.51.100.3:8080")
	run("iptables", "-D", "DOCKER-USER", "1")
	syncPolicy()
	if !isOpen("4", "192.0.2.2", "tcp", "12080") || isOpen("4", "192.0.2.2", "tcp", "12081") {
		t.Fatal("container IP change or jump loss invalidated the policy")
	}
	run("iptables", "-I", "FORWARD", "1", "-s", "192.0.2.3", "-j", "DROP")
	syncPolicy()
	filter := readDockerFilter(run("iptables", "-S"))
	if len(filter.forward) < 3 || filter.forward[0] != dockerEntry || !strings.Contains(filter.forward[1], "192.0.2.3") ||
		filter.forward[2] != "-j DOCKER-USER" || containsDockerRule(filter.docker, dockerEntry) {
		t.Fatalf("fallback changed external FORWARD ordering: %+v", filter)
	}
	for i := 0; i < 7; i++ {
		if open := isOpen("4", "192.0.2.2", "tcp", "12082"); (i == 0 && !open) || (i == 6 && open) {
			t.Fatalf("UFW limit verdict at attempt %d: %v", i+1, open)
		}
	}
	run("ufw", "--force", "delete", "allow", "13478/udp")
	syncPolicy()
	if isOpen("6", "2001:db8:1::2", "udp", "13478") {
		t.Fatal("deleted UFW rule remained effective on a new flow")
	}
	scan, err := setScanSection(string(beforeV4), true, ScanConfig{
		Ports: []float64{12080}, WindowSeconds: 30, HitCount: 3, BanSeconds: 60,
	}, "v4")
	if err != nil {
		t.Fatal(err)
	}
	beforeV4 = []byte(scan)
	syncPolicy()
	for i := 0; i < 4; i++ {
		if open := isOpen("4", "192.0.2.2", "tcp", "12080"); (i == 0 && !open) || (i == 3 && open) {
			t.Fatalf("scan verdict at attempt %d: %v", i+1, open)
		}
	}
	start("python3", "-u", "-c", `
import socket
s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
s.bind(("2001:db8:1::1", 12083))
s.listen()
print("ready")
while True:
    peer, _ = s.accept()
    peer.sendall(b"ok")
    peer.close()
`)
	run("ufw", "--force", "enable")
	if isOpen("6", "2001:db8:1::2", "tcp", "12083") {
		t.Fatal("IPv6 host listener bypassed UFW INPUT policy")
	}
	run("ufw", "allow", "12083/tcp")
	run("ufw", "reload")
	syncPolicy()
	if !isOpen("6", "2001:db8:1::2", "tcp", "12083") || isOpen("6", "2001:db8:1::2", "tcp", "12081") {
		t.Fatal("host INPUT or Docker forwarding disagrees with UFW after reload")
	}
	if err := d.reconcile(ctx, true); err != nil {
		t.Fatal(err)
	}
	if !isOpen("4", "192.0.2.2", "tcp", "12081") {
		t.Fatal("removing the integration changed Docker's original forwarding behavior")
	}
}
