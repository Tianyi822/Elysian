package firewall

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestProjectDockerInput(t *testing.T) {
	user := `:ufw-user-input - [0:0]
-A ufw-user-input -i eth0 -s 192.0.2.2 -p tcp -d 198.51.100.1 --dport 12080 -j DROP
-A ufw-user-input -p tcp -m multiport --dports 12080,12443,15000:15003 -j ACCEPT
-A ufw-user-input -p udp --dport 3478 -s 192.0.2.0/24 -j ACCEPT
-A ufw-user-input -p tcp --dport 26755 -m conntrack --ctstate NEW -m recent --set
-A ufw-user-input -p tcp --dport 26755 -m conntrack --ctstate NEW -m recent --update --seconds 30 --hitcount 6 -j ufw-user-limit
-A ufw-user-input -p tcp --dport 26755 -j ufw-user-limit-accept
-A ufw-user-input -p tcp --dport 40223 -j ufw-user-logging-input
-A ufw-user-input -p tcp --dport 40223 -j REJECT --reject-with tcp-reset
-A ufw-user-output -p tcp --dport 9999 -j ACCEPT
-A ufw-user-forward -p udp --dport 9999 -j ACCEPT
COMMIT
`
	forward := ForwardSpec{Protocol: "tcp", Port: "3100", TargetHost: "203.0.113.2", TargetPort: 3000}
	before := setForwardSection("", []ForwardSpec{forward})
	got, err := projectDockerInput(user, before, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
		"-p tcp -d 203.0.113.2 --dport 3000 -m conntrack --ctorigdstport 3100 -j RETURN",
		"-i eth0 -s 192.0.2.2 -p tcp -m conntrack --ctorigdst 198.51.100.1 --ctorigdstport 12080 -j DROP",
		"-p tcp -m conntrack --ctorigdstport 12080 -j RETURN",
		"-p tcp -m conntrack --ctorigdstport 12443 -j RETURN",
		"-p tcp -m conntrack --ctorigdstport 15000:15003 -j RETURN",
		"-p udp -s 192.0.2.0/24 -m conntrack --ctorigdstport 3478 -j RETURN",
		"-p tcp -m conntrack --ctstate NEW --ctorigdstport 26755 -m recent --set",
		"-p tcp -m conntrack --ctstate NEW --ctorigdstport 26755 -m recent --update --seconds 30 --hitcount 6 -j REJECT",
		"-p tcp -m conntrack --ctorigdstport 26755 -j RETURN",
		"-p tcp -m conntrack --ctorigdstport 40223 -j REJECT --reject-with tcp-reset",
		"-j DROP",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if _, err := projectDockerInput(user+"-A ufw-user-input -m set --match-set policy src -j DROP\n", before, false); err == nil {
		t.Fatal("unsupported input match was silently omitted")
	}
}

func TestProjectDockerScanIPv6(t *testing.T) {
	before, err := setScanSection("*filter\n:ufw6-before-input - [0:0]\nCOMMIT\n", true,
		ScanConfig{Ports: []float64{12080, 12443}, WindowSeconds: 30, HitCount: 3, BanSeconds: 60}, "v6")
	if err != nil {
		t.Fatal(err)
	}
	user := ":ufw6-user-input - [0:0]\n-A ufw6-user-input -d 2001:db8::1 -p tcp --dport 12080 -j ACCEPT\nCOMMIT\n"
	rules, err := projectDockerInput(user, before, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 9 || !strings.Contains(rules[1], "--ctorigdstport 12080 -m recent --name ELYSIAN_SCAN_BANNED6") ||
		!strings.Contains(rules[4], "--name ELYSIAN_SCAN_BANNED6 --set -j DROP") ||
		rules[7] != "-p tcp -m conntrack --ctorigdst 2001:db8::1 --ctorigdstport 12080 -j RETURN" {
		t.Fatalf("unexpected IPv6 scan ordering: %v", rules)
	}
}

func TestDockerFilterOwnedChangesAndRollback(t *testing.T) {
	original := readDockerFilter("-N DOCKER-USER\n-A FORWARD -j DOCKER-USER\n-A DOCKER-USER -s 192.0.2.1 -j DROP\n")
	policy := stampDockerPolicy(append(dockerEstablished(), "-j DROP"))
	batch := dockerFilterBatch(original, policy, nil)
	if !strings.Contains(batch, "-I DOCKER-USER 1 "+dockerEntry) || strings.Contains(batch, "-I FORWARD") ||
		strings.Contains(batch, "-F DOCKER-USER") {
		t.Fatalf("batch touched an external rule: %s", batch)
	}
	current := original
	current.docker = append([]string{dockerEntry}, current.docker...)
	current.hasInput, current.input = true, policy
	rollback := dockerFilterBatch(current, nil, &original)
	if !strings.Contains(rollback, "-D DOCKER-USER "+dockerEntry) || !strings.Contains(rollback, "-X "+dockerInputChain) ||
		strings.Contains(rollback, "-X DOCKER-USER") || strings.Contains(rollback, "192.0.2.1") {
		t.Fatalf("invalid rollback batch: %s", rollback)
	}
	earlier := original
	earlier.forward = append([]string{"-s 192.0.2.1 -j DROP"}, earlier.forward...)
	batch = dockerFilterBatch(earlier, policy, nil)
	if !strings.Contains(batch, "-I FORWARD 1 "+dockerEntry) || strings.Contains(batch, "-I DOCKER-USER") ||
		strings.Contains(batch, "192.0.2.1") || strings.Contains(batch, "-j DOCKER-USER") {
		t.Fatalf("fallback changed external chain ordering: %s", batch)
	}
}

func TestDockerFilterIPv6FailureRestoresIPv4(t *testing.T) {
	original := "-N DOCKER-USER\n-A FORWARD -j DOCKER-USER\n-A DOCKER-USER -j RETURN\n"
	policy := stampDockerPolicy(append(dockerEstablished(), "-j DROP"))
	installed := "-N " + dockerInputChain + "\n-N DOCKER-USER\n-A FORWARD -j DOCKER-USER\n-A DOCKER-USER " + dockerEntry + "\n-A DOCKER-USER -j RETURN\n"
	for _, rule := range policy {
		installed += "-A " + dockerInputChain + " " + rule + "\n"
	}
	current := readDockerFilter(original)
	var applyOrder []string
	policyV4 := original
	d := &dockerFirewall{cache: make(map[string][]string), run: func(_ context.Context, stdin, program string, args ...string) (string, error) {
		switch program {
		case "iptables":
			return policyV4, nil
		case "ip6tables":
			return original, nil
		}
		if args[len(args)-1] == "--test" {
			applyOrder = append(applyOrder, "test "+program)
			return "", nil
		}
		applyOrder = append(applyOrder, program)
		if program == "ip6tables-restore" && strings.Contains(stdin, "-I DOCKER-USER") {
			return "", errors.New("IPv6 apply failed")
		}
		if program == "iptables-restore" {
			if strings.Contains(stdin, "-I DOCKER-USER") {
				policyV4 = installed
			} else if strings.Contains(stdin, "-X "+dockerInputChain) {
				policyV4 = original
			}
		}
		return "", nil
	}}
	plans := []dockerFilterPlan{
		{binary: "iptables", current: current, rules: policy, batch: dockerFilterBatch(current, policy, nil)},
		{binary: "ip6tables", current: current, rules: policy, batch: dockerFilterBatch(current, policy, nil)},
	}
	err := d.applyDockerFilters(context.Background(), plans)
	wantOrder := []string{"test iptables-restore", "test ip6tables-restore", "iptables-restore", "ip6tables-restore", "ip6tables-restore", "iptables-restore"}
	if err == nil || !strings.Contains(err.Error(), "IPv6 apply failed") || policyV4 != original || !reflect.DeepEqual(applyOrder, wantOrder) {
		t.Fatalf("err=%v v4=%q order=%v", err, policyV4, applyOrder)
	}
}
