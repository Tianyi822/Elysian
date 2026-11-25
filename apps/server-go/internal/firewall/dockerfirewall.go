package firewall

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"syscall"
	"time"
)

const (
	dockerFirewallRoot    = "/opt/elysian/docker-firewall"
	dockerFirewallLock    = "/run/elysian-docker-firewall.lock"
	dockerLifecycleLock   = "/run/elysian-docker-firewall-lifecycle.lock"
	dockerFirewallService = "elysian-docker-firewall.service"
	dockerFirewallTimeout = 25 * time.Second
)

type dockerFirewall struct {
	run   dockerFirewallCommand
	read  func(string) ([]byte, error)
	ipv6  bool
	cache map[string][]string
}

func newDockerFirewall() *dockerFirewall {
	_, ipv6Err := os.Stat("/proc/sys/net/ipv6/conf/all")
	return &dockerFirewall{
		run:   runDockerFirewallCommand,
		read:  os.ReadFile,
		ipv6:  ipv6Err == nil,
		cache: make(map[string][]string),
	}
}

func withDockerFirewallLock(ctx context.Context, operate func() error) error {
	return withFirewallLock(ctx, dockerFirewallLock, operate)
}

func withFirewallLock(ctx context.Context, path string, operate func() error) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	timer := time.NewTicker(50 * time.Millisecond)
	defer timer.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return operate()
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func ufwSetting(text, name string) string {
	var value string
	for _, line := range strings.Split(text, "\n") {
		left, right, ok := strings.Cut(strings.TrimSpace(strings.SplitN(line, "#", 2)[0]), "=")
		if ok && strings.TrimSpace(left) == name {
			value = strings.Trim(strings.TrimSpace(right), "\"'")
		}
	}
	return value
}

func (d *dockerFirewall) families() []string {
	if d.ipv6 {
		return []string{"iptables", "ip6tables"}
	}
	return []string{"iptables"}
}

// dockerPlans builds all families before touching either one. Once protection
// is installed an unprojectable edit must not retain stale access grants.
func (d *dockerFirewall) dockerPlans(ctx context.Context, first, remove, restrict bool) ([]dockerFilterPlan, error) {
	var active, ufwIPv6 bool
	var configurationErr error
	if !remove {
		conf, err := d.read(defaultFirewallPaths.UfwConf)
		defaults, defaultsErr := d.read(defaultFirewallPaths.DefaultUfw)
		configurationErr = errors.Join(err, defaultsErr)
		switch ufwSetting(string(conf), "ENABLED") {
		case "yes":
			active = true
		case "no":
		default:
			configurationErr = errors.Join(configurationErr, errors.New("无法确认 UFW 启停配置"))
		}
		if ufwSetting(string(defaults), "MANAGE_BUILTINS") == "yes" {
			configurationErr = errors.Join(configurationErr, errors.New("UFW MANAGE_BUILTINS=yes 会清空 Docker 所依赖的转发链"))
		}
		ufwIPv6 = parseIpv6Enabled(string(defaults))
		if configurationErr != nil {
			if first {
				return nil, configurationErr
			}
			active, restrict = true, true
		}
	}
	var plans []dockerFilterPlan
	var projectionErr error
	for _, binary := range d.families() {
		current, err := d.filter(ctx, binary)
		if err != nil {
			return nil, err
		}
		if current.hasInput && !current.owned() {
			return nil, fmt.Errorf("%s 已有无法确认归属的 %s 链", binary, dockerInputChain)
		}
		if first && current.owned() {
			return nil, fmt.Errorf("%s 已存在 Docker 防火墙接管规则，请先确认原管理组件", binary)
		}
		var rules []string
		if active {
			v6 := binary == "ip6tables"
			rules = append(dockerEstablished(), "-j DROP")
			if !restrict && (!v6 || ufwIPv6) {
				path := defaultFirewallPaths.BeforeRules
				userPath := "/etc/ufw/user.rules"
				if v6 {
					path, userPath = defaultFirewallPaths.BeforeRulesV6, "/etc/ufw/user6.rules"
				}
				user, userErr := d.read(userPath)
				before, beforeErr := d.read(path)
				err = errors.Join(userErr, beforeErr)
				if err == nil {
					var projected []string
					projected, err = projectDockerInput(string(user), string(before), v6)
					if err == nil {
						rules = projected
					}
				}
				if err != nil {
					projectionErr = errors.Join(projectionErr, err)
				}
			}
			rules = stampDockerPolicy(rules)
		}
		known := d.cache[binary]
		sameVersion := len(known) > 0 && len(current.input) > 0 && known[len(known)-1] == current.input[len(current.input)-1]
		if current.matches(rules) && (!sameVersion || reflect.DeepEqual(known, current.input)) {
			d.cache[binary] = current.input
			continue
		}
		plans = append(plans, dockerFilterPlan{
			binary: binary, current: current, rules: rules, batch: dockerFilterBatch(current, rules, nil),
		})
	}
	if first && projectionErr != nil {
		return nil, projectionErr
	}
	return plans, errors.Join(configurationErr, projectionErr)
}

func (d *dockerFirewall) reconcile(ctx context.Context, remove bool) error {
	plans, policyErr := d.dockerPlans(ctx, false, remove, false)
	if policyErr != nil && plans == nil {
		return policyErr
	}
	if err := d.applyDockerFilters(ctx, plans); err != nil {
		if remove {
			return errors.Join(policyErr, err)
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
		defer cancel()
		restricted, restrictErr := d.dockerPlans(recoveryCtx, false, false, true)
		restrictErr = errors.Join(restrictErr, d.applyDockerFilters(recoveryCtx, restricted))
		if restrictErr != nil {
			restrictErr = fmt.Errorf("无法确认 Docker 默认拒绝策略：%w", restrictErr)
		}
		return errors.Join(policyErr, err, restrictErr)
	}
	return policyErr
}

// withDockerChange keeps the last verified policy in place during the
// panel's temporary UFW disable/enable cycle and also reconciles partial edits.
func (d *dockerFirewall) withDockerChange(change func() error) error {
	if d == nil {
		return change()
	}
	owned, err := dockerFirewallInstalled()
	if err != nil {
		return err
	}
	if !owned {
		return change()
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
	defer cancel()
	return withDockerFirewallLock(ctx, func() error {
		changeErr := change()
		applyCtx, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
		defer cancel()
		if err := d.reconcile(applyCtx, false); err != nil {
			return errors.Join(changeErr, fmt.Errorf("Docker 防火墙同步未确认，请同步规则后重试：%w", err))
		}
		return changeErr
	})
}
