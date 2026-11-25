package firewall

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"elysian/server/internal/shared"
)

const (
	dockerUserChain = "DOCKER-USER"
	dockerRuleOwner = "ELYSIAN-DOCKER-UFW"
	dockerEntry     = "-m conntrack --ctstate DNAT --ctdir ORIGINAL -m comment --comment " + dockerRuleOwner + " -j " + dockerInputChain
)

type dockerFilter struct {
	hasInput bool
	forward  []string
	docker   []string
	input    []string
}

func readDockerFilter(raw string) dockerFilter {
	var filter dockerFilter
	for _, line := range strings.Split(raw, "\n") {
		switch {
		case line == "-N "+dockerInputChain:
			filter.hasInput = true
		case strings.HasPrefix(line, "-A FORWARD "):
			filter.forward = append(filter.forward, strings.TrimPrefix(line, "-A FORWARD "))
		case strings.HasPrefix(line, "-A "+dockerUserChain+" "):
			filter.docker = append(filter.docker, strings.TrimPrefix(line, "-A "+dockerUserChain+" "))
		case strings.HasPrefix(line, "-A "+dockerInputChain+" "):
			filter.input = append(filter.input, strings.TrimPrefix(line, "-A "+dockerInputChain+" "))
		}
	}
	return filter
}

func (f dockerFilter) owned() bool {
	if containsDockerRule(f.docker, dockerEntry) || containsDockerRule(f.forward, dockerEntry) {
		return true
	}
	// The terminal verdict binds a complete, installed chain to our format
	// even if a firewall reload removes the jump to it.
	return len(f.input) > 0 && strings.HasPrefix(f.input[len(f.input)-1], "-m comment --comment "+dockerRuleOwner+"-")
}

func (f dockerFilter) matches(rules []string) bool {
	if len(rules) == 0 {
		return !f.hasInput && !containsDockerRule(f.forward, dockerEntry) && !containsDockerRule(f.docker, dockerEntry)
	}
	if len(f.forward) == 0 || !f.hasInput || len(f.input) != len(rules) || f.input[len(f.input)-1] != rules[len(rules)-1] {
		return false
	}
	switch f.forward[0] {
	case "-j " + dockerUserChain:
		return len(f.docker) > 0 && f.docker[0] == dockerEntry && countDockerRule(f.docker, dockerEntry) == 1 &&
			!containsDockerRule(f.forward, dockerEntry)
	case dockerEntry:
		return countDockerRule(f.forward, dockerEntry) == 1 && !containsDockerRule(f.docker, dockerEntry)
	default:
		return false
	}
}

func countDockerRule(rules []string, want string) int {
	count := 0
	for _, rule := range rules {
		if rule == want {
			count++
		}
	}
	return count
}

func containsDockerRule(rules []string, want string) bool {
	return countDockerRule(rules, want) != 0
}

func stampDockerPolicy(rules []string) []string {
	hash := sha256.Sum256([]byte(strings.Join(rules, "\n")))
	last := fmt.Sprintf("-m comment --comment %s-%x -j DROP", dockerRuleOwner, hash)
	return append(append([]string(nil), rules[:len(rules)-1]...), last)
}

// dockerFilterBatch edits only owned rules. A filter-table COMMIT swaps the
// complete chain and its dispatch rules together within one address family.
func dockerFilterBatch(current dockerFilter, input []string, restore *dockerFilter) string {
	lines := []string{"*filter"}
	if current.hasInput {
		lines = append(lines, "-F "+dockerInputChain)
	}
	for _, r := range current.docker {
		if r == dockerEntry {
			lines = append(lines, "-D "+dockerUserChain+" "+r)
		}
	}
	for _, r := range current.forward {
		if r == dockerEntry {
			lines = append(lines, "-D FORWARD "+r)
		}
	}
	if restore != nil {
		input = restore.input
	}
	if len(input) == 0 && (restore == nil || !restore.hasInput) {
		if current.hasInput {
			lines = append(lines, "-X "+dockerInputChain)
		}
	} else {
		if !current.hasInput {
			lines = append(lines, "-N "+dockerInputChain)
		}
		for _, rule := range input {
			lines = append(lines, "-A "+dockerInputChain+" "+rule)
		}
		if restore == nil {
			if len(current.forward) > 0 && current.forward[0] == "-j "+dockerUserChain {
				lines = append(lines, "-I "+dockerUserChain+" 1 "+dockerEntry)
			} else {
				// Before Docker initializes this family, or when another
				// FORWARD rule comes first, gate directly without changing
				// the order of the administrator's DOCKER-USER rules.
				lines = append(lines, "-I FORWARD 1 "+dockerEntry)
			}
		} else {
			for i, rule := range restore.docker {
				if rule == dockerEntry {
					lines = append(lines, fmt.Sprintf("-I %s %d %s", dockerUserChain, i+1, rule))
				}
			}
			for i, rule := range restore.forward {
				if rule == dockerEntry {
					lines = append(lines, fmt.Sprintf("-I FORWARD %d %s", i+1, rule))
				}
			}
		}
	}
	return strings.Join(append(lines, "COMMIT", ""), "\n")
}

type dockerFirewallCommand func(context.Context, string, string, ...string) (string, error)

func runDockerFirewallCommand(ctx context.Context, stdin, name string, args ...string) (string, error) {
	cmd, cmdCtx, cancel := shared.SystemCommand(ctx, name, args...)
	defer cancel()
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "HOME=/root"}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%s：%w", name, shared.CommandErrorWithStderr(shared.SystemCommandError(cmdCtx, err), ""))
	}
	return string(out), nil
}

type dockerFilterPlan struct {
	binary  string
	current dockerFilter
	rules   []string
	batch   string
}

func (d *dockerFirewall) filter(ctx context.Context, binary string) (dockerFilter, error) {
	raw, err := d.run(ctx, "", binary, "-w", "5", "-S")
	if err != nil {
		return dockerFilter{}, err
	}
	return readDockerFilter(raw), nil
}

func (d *dockerFirewall) applyDockerFilters(ctx context.Context, plans []dockerFilterPlan) error {
	for _, plan := range plans {
		if _, err := d.run(ctx, plan.batch, plan.binary+"-restore", "-w", "5", "--noflush", "--test"); err != nil {
			return fmt.Errorf("验证 Docker 防火墙内核批次失败：%w", err)
		}
	}
	applied := 0
	for i, plan := range plans {
		// If a command times out, the commit may have happened. Include the
		// attempted family in the recovery and inspect it before reverting.
		applied = i + 1
		_, err := d.run(ctx, plan.batch, plan.binary+"-restore", "-w", "5", "--noflush")
		if err == nil {
			var fresh dockerFilter
			fresh, err = d.filter(ctx, plan.binary)
			if err == nil && fresh.matches(plan.rules) {
				d.cache[plan.binary] = fresh.input
				continue
			}
			if err == nil {
				err = fmt.Errorf("%s 回读未确认 Docker 规则或跳转顺序", plan.binary)
			}
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
		recoveryErr := d.restoreDockerFilters(recoveryCtx, plans[:applied])
		cancel()
		return errors.Join(err, recoveryErr)
	}
	return nil
}

func (d *dockerFirewall) restoreDockerFilters(ctx context.Context, plans []dockerFilterPlan) error {
	var recoveryErr error
	for i := len(plans) - 1; i >= 0; i-- {
		plan := plans[i]
		fresh, err := d.filter(ctx, plan.binary)
		if err == nil {
			batch := dockerFilterBatch(fresh, nil, &plan.current)
			_, err = d.run(ctx, batch, plan.binary+"-restore", "-w", "5", "--noflush")
		}
		if err != nil {
			recoveryErr = errors.Join(recoveryErr, fmt.Errorf("恢复 %s 的 Docker 防火墙规则失败：%w", plan.binary, err))
		}
		delete(d.cache, plan.binary)
	}
	return recoveryErr
}

var (
	dnatRule      = regexp.MustCompile(`\s-j DNAT(?:\s|$)`)
	elysianDnat   = regexp.MustCompile(`\s--comment (?:"ELYSIAN-FWD(?: [^"]*)?"|ELYSIAN-FWD)(?:\s|$)`)
	dockerIngress = regexp.MustCompile(`(?m)^-N DOCKER-INGRESS$`)
)

func checkDockerNAT(raw string) error {
	if dockerIngress.MatchString(raw) {
		return errors.New("发现 Docker Swarm ingress，宿主发布端口接管不支持该路径")
	}
	for _, line := range strings.Split(raw, "\n") {
		if !dnatRule.MatchString(line) || strings.HasPrefix(line, "-A DOCKER ") {
			continue
		}
		if strings.HasPrefix(line, "-A PREROUTING ") && elysianDnat.MatchString(line) {
			continue
		}
		return errors.New("发现非 Docker、非 Elysian 的 DNAT 规则，无法安全接管，请核对宿主 NAT 配置")
	}
	return nil
}
