package firewall

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/atomicfile"
	"elysian/server/internal/config"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared/randomid"
)

const dockerAllowComment = "Elysian Docker v4 "
const dockerAllowUserRules = "/etc/ufw/user.rules"
const dockerAllowLedgerLimit = 2 << 20

var dockerAllowMarker = regexp.MustCompile(`^Elysian Docker v4 [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var dockerAllowOwner = regexp.MustCompile(`^[0-9a-f]{64}$`)

type containerPortOwnership struct {
	Binding contract.DockerPublishedPort `json:"binding"`
	Comment string                       `json:"comment"`
}

type containerFirewall struct {
	mu        sync.Mutex
	host      hostDeps
	policy    *dockerFirewall
	path      string
	published func(context.Context) ([]contract.DockerPublishedPort, error)
	inventory func(context.Context, bool) (map[string]bool, []contract.DockerPublishedPort, error)
}

func NewContainerFirewall(deps Deps, path string, inventory func(context.Context, bool) (map[string]bool, []contract.DockerPublishedPort, error)) seam.ContainerFirewall {
	if !deps.Available || deps.Mode != config.ModeBareMetal {
		return nil
	}
	return &containerFirewall{host: newExecHostDeps("", deps.Now), policy: newDockerFirewall(),
		path: path, published: deps.PublishedPorts, inventory: inventory}
}

func WatchContainerFirewall(policy seam.ContainerFirewall, warn func(error)) func(context.Context) error {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		lastError := ""
		for {
			run, finish := context.WithTimeout(ctx, 25*time.Second)
			err := policy.Reconcile(run)
			finish()
			if err == nil {
				lastError = ""
			} else if ctx.Err() == nil && err.Error() != lastError {
				lastError = err.Error()
				warn(err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func(ctx context.Context) error {
		cancel()
		select {
		case <-done:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func validContainerAllow(binding contract.DockerPublishedPort) bool {
	return dockerAllowOwner.MatchString(binding.ContainerID) && binding.HostIP == "0.0.0.0" &&
		binding.HostPort > 0 && binding.HostPort <= 65535 && binding.ContainerPort > 0 && binding.ContainerPort <= 65535 &&
		(binding.Protocol == "tcp" || binding.Protocol == "udp")
}

func (p *containerFirewall) load() ([]containerPortOwnership, error) {
	uid := uint32(os.Geteuid())
	file, err := atomicfile.OpenTrusted(p.path, atomicfile.TrustOptions{
		OwnerUID: &uid, RejectPerm: 0o077, SingleLink: true, MaxBytes: dockerAllowLedgerLimit,
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, dockerAllowLedgerLimit+1))
	var rows []containerPortOwnership
	if err != nil || len(data) > dockerAllowLedgerLimit || json.Unmarshal(data, &rows) != nil {
		return nil, errors.New("Docker 防火墙规则归属账本无效")
	}
	seen := make(map[string]bool)
	for _, row := range rows {
		if !validContainerAllow(row.Binding) || !dockerAllowMarker.MatchString(row.Comment) || seen[row.Comment] {
			return nil, errors.New("Docker 防火墙规则归属记录无效")
		}
		seen[row.Comment] = true
	}
	return rows, nil
}

func (p *containerFirewall) save(rows []containerPortOwnership) error {
	return atomicfile.WriteJSON(p.path, rows, atomicfile.JSONOptions{WriteOptions: atomicfile.WriteOptions{
		CreateParent: true, DirSync: true,
	}})
}

func (r containerPortOwnership) args() []string {
	return specToArgs(ufwRuleSpec{Action: "allow", Direction: "in", Port: strconv.Itoa(r.Binding.HostPort),
		Proto: r.Binding.Protocol, From: "0.0.0.0/0"})
}

// UFW keeps the comment on the saved rule tuple and omits it from the actual
// iptables rule. Require both records and a unique rule before an owned delete.
func (r containerPortOwnership) present(raw string) bool {
	port := strconv.Itoa(r.Binding.HostPort)
	tuple := fmt.Sprintf("### tuple ### allow %s %s 0.0.0.0/0 any 0.0.0.0/0 in comment=%s",
		r.Binding.Protocol, port, hex.EncodeToString([]byte(r.Comment)))
	rule := fmt.Sprintf("-A ufw-user-input -p %s --dport %s -j ACCEPT", r.Binding.Protocol, port)
	lines := strings.Split(raw, "\n")
	matches := 0
	for i, line := range lines {
		if line == rule {
			if i == 0 || lines[i-1] != tuple {
				return false
			}
			matches++
		}
	}
	return matches == 1
}

// existingContainerPolicy considers ordered projected rules for a new IPv4
// flow. Any possible earlier restriction or conditional grant keeps its policy.
func existingContainerPolicy(rules []string, port int, protocol string) string {
	for _, line := range rules[1 : len(rules)-1] {
		args := strings.Fields(line)
		matches, conditional, action := true, false, ""
		for i := 0; i+1 < len(args); i++ {
			flag, value := args[i], args[i+1]
			switch flag {
			case "!", "--rsource", "--set", "--update", "--rcheck":
				conditional = true
				continue
			}
			switch flag {
			case "-p":
				matches = matches && (value == protocol || value == "all" || protocol == "tcp" && value == "6" || protocol == "udp" && value == "17")
			case "--ctorigdstport":
				low, high, hasRange := strings.Cut(value, ":")
				minPort, _ := strconv.Atoi(low)
				maxPort := minPort
				if hasRange {
					maxPort, _ = strconv.Atoi(high)
				}
				matches = matches && port >= minPort && port <= maxPort
			case "--ctstate":
				conditional = conditional || value != "NEW"
			case "-s", "--ctorigdst":
				conditional = conditional || value != "0.0.0.0/0"
			case "-m":
				conditional = conditional || value != "conntrack"
			case "-j":
				action = value
			default:
				conditional = true
			}
			i++
		}
		if !matches {
			continue
		}
		if action == "RETURN" && !conditional {
			return "existing"
		}
		return "skipped"
	}
	return ""
}

func (p *containerFirewall) Allow(ctx context.Context, binding contract.DockerPublishedPort) (string, string) {
	if !validContainerAllow(binding) {
		return "skipped", "此绑定不支持自动放行"
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.policy != nil {
		installed, err := dockerFirewallInstalled()
		if err != nil || !installed {
			return "unknown", "无法确认宿主 Docker 防火墙已接管"
		}
	}
	state, detail := "failed", ""
	wrote := false
	err := p.policy.withDockerChange(func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		live, err := p.published(ctx)
		if err != nil || !slices.ContainsFunc(live, func(port contract.DockerPublishedPort) bool {
			port.ContainerName = ""
			return port == binding
		}) {
			state, detail = "unknown", "Docker 当前发布端口与创建请求不一致"
			return nil
		}
		raw, err := p.host.ReadText(dockerAllowUserRules)
		if err != nil {
			return err
		}
		before, err := p.host.ReadText(p.host.Paths().BeforeRules)
		if err != nil {
			return err
		}
		conf, err := p.host.ReadText(p.host.Paths().UfwConf)
		if err != nil {
			return err
		}
		rules, err := projectDockerInput(raw, before, false)
		if err != nil {
			return err
		}
		state = existingContainerPolicy(rules, binding.HostPort, binding.Protocol)
		if state == "skipped" {
			detail = "保留已有的来源限制、拒绝或限连策略"
		}
		if state != "" {
			return nil
		}
		if countSavedPortRules(raw) >= firewallLimitUserRules {
			return errors.New("端口规则已达上限")
		}
		rows, err := p.load()
		if err != nil {
			return err
		}
		row := containerPortOwnership{Binding: binding, Comment: dockerAllowComment + randomid.UUIDv4()}
		// Record the intent first so that an interrupted command remains traceable.
		if err := p.save(append(rows, row)); err != nil {
			return err
		}
		wrote = true
		_, writeErr := p.host.RunUfw(append(row.args(), "comment", row.Comment))
		after, readErr := p.host.ReadText(dockerAllowUserRules)
		if err := errors.Join(writeErr, readErr); err != nil {
			return err
		}
		if !row.present(after) {
			return errors.New("未能回读本次新增的放行规则")
		}
		state = "added"
		if ufwSetting(conf, "ENABLED") == "no" {
			detail = "放行规则已保存，防火墙当前关闭"
		}
		return nil
	})
	if err != nil {
		if wrote || state == "existing" {
			return "unknown", err.Error()
		}
		return "failed", err.Error()
	}
	return state, detail
}

func countSavedPortRules(raw string) int {
	count := 0
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 10 && strings.HasPrefix(line, "### tuple ### ") && fields[5] != "any" {
			count++
		}
	}
	return count
}

func (p *containerFirewall) Reconcile(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows, err := p.load()
	if err != nil || len(rows) == 0 {
		return err
	}
	ids, _, err := p.inventory(ctx, false)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !ids[row.Binding.ContainerID] {
			return p.releaseOrphans(ctx, rows)
		}
	}
	return nil
}

func (p *containerFirewall) releaseOrphans(ctx context.Context, rows []containerPortOwnership) error {
	return p.policy.withDockerChange(func() error {
		ids, bindings, err := p.inventory(ctx, true)
		if err != nil {
			return err
		}
		retained := make([]containerPortOwnership, 0, len(rows))
		var faults []error
		for _, row := range rows {
			if err := ctx.Err(); err != nil {
				return err
			}
			if ids[row.Binding.ContainerID] {
				retained = append(retained, row)
				continue
			}
			shared := false
			for _, binding := range bindings {
				ip, _ := netip.ParseAddr(binding.HostIP)
				if row.Binding.HostPort == binding.HostPort && row.Binding.Protocol == binding.Protocol &&
					(binding.HostIP == "" || ip.Unmap().Is4()) {
					shared = true
					break
				}
			}
			if shared {
				continue
			}
			raw, err := p.host.ReadText(dockerAllowUserRules)
			if err == nil && row.present(raw) {
				_, err = p.host.RunUfw(append([]string{"delete"}, row.args()...))
				if err == nil {
					raw, err = p.host.ReadText(dockerAllowUserRules)
					if err == nil && row.present(raw) {
						err = errors.New("Docker 放行规则删除结果未确认")
					}
				}
			}
			if err != nil {
				faults = append(faults, err)
				retained = append(retained, row)
			}
		}
		if len(retained) != len(rows) {
			faults = append(faults, p.save(retained))
		}
		return errors.Join(faults...)
	})
}

func (p *containerFirewall) Transfer(oldID, nextID string, bindings []contract.DockerPublishedPort) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows, err := p.load()
	if err != nil {
		return err
	}
	changed := false
	for i, row := range rows {
		if row.Binding.ContainerID != oldID {
			continue
		}
		row.Binding.ContainerID = nextID
		for _, binding := range bindings {
			if row.Binding == binding {
				rows[i] = row
				changed = true
				break
			}
		}
	}
	if changed {
		return p.save(rows)
	}
	return nil
}
