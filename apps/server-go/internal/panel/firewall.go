package panel

import (
	"context"
	"elysian/server/internal/config"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var rulePort = regexp.MustCompile(`^[0-9]+(?::[0-9]+)?(?:,[0-9]+(?::[0-9]+)?)*(?:/(?:tcp|udp))?$`)

// UFW show added 输出是固定命令账本；只拆 argv，绝不交给 shell 解释。
func ruleArgs(text string) ([]string, error) {
	var args []string
	var word strings.Builder
	quote := rune(0)
	escaped := false
	for _, c := range text {
		if escaped {
			word.WriteRune(c)
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			} else {
				word.WriteRune(c)
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == ' ' || c == '\t' {
			if word.Len() > 0 {
				args = append(args, word.String())
				word.Reset()
			}
			continue
		}
		word.WriteRune(c)
	}
	if quote != 0 || escaped {
		return nil, fmt.Errorf("防火墙规则格式无效")
	}
	if word.Len() > 0 {
		args = append(args, word.String())
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("防火墙规则为空")
	}
	return args, nil
}
func managedRule(rule string) bool {
	args, err := ruleArgs(rule)
	if err != nil {
		return false
	}
	for i, arg := range args {
		if arg == "comment" && i+1 < len(args) {
			return args[i+1] == "Elysian 面板" || args[i+1] == "面板保底"
		}
	}
	return false
}
func ruleCovers(rule string, port int) bool {
	args, err := ruleArgs(rule)
	if err != nil {
		return true
	}
	found := false
	for _, arg := range args {
		if arg == "comment" {
			break
		}
		if !rulePort.MatchString(arg) {
			continue
		}
		found = true
		for _, segment := range strings.Split(strings.Split(arg, "/")[0], ",") {
			bounds := strings.Split(segment, ":")
			lo, _ := strconv.Atoi(bounds[0])
			hi := lo
			if len(bounds) == 2 {
				hi, _ = strconv.Atoi(bounds[1])
			}
			if lo <= port && port <= hi {
				return true
			}
		}
	}
	// 应用配置由 Rules 现场展开为额外的端口记录；无端口的地址规则覆盖全部端口。
	if !found && len(args) > 1 && args[1] != "from" && args[1] != "to" && args[1] != "in" && args[1] != "out" && args[1] != "on" {
		return false
	}
	return !found
}
func frontendRule(port int) string { return fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", port) }
func relevantRule(rule string, old, next config.PanelNetwork) bool {
	return ruleCovers(rule, old.FrontendPort) || ruleCovers(rule, old.BackendPort) || ruleCovers(rule, next.FrontendPort) || ruleCovers(rule, next.BackendPort)
}
func validateRules(rules []string, old, next config.PanelNetwork) error {
	for _, rule := range rules {
		if !relevantRule(rule, old, next) {
			continue
		}
		args, err := ruleArgs(rule)
		if err != nil {
			return err
		}
		if !managedRule(rule) {
			return fmt.Errorf("面板端口与非面板防火墙规则冲突，请先在安全页处理：%s", rule)
		}
		if len(args) != 4 || args[0] != "allow" || !strings.HasSuffix(args[1], "/tcp") || strings.ContainsAny(args[1], ":,") || args[2] != "comment" {
			return fmt.Errorf("面板端口存在共享或非标准规则，无法安全迁移：%s", rule)
		}
	}
	return nil
}
func (h SystemHost) Rules(ctx context.Context) ([]string, error) {
	out, err := h.command(ctx, "ufw", "show", "added")
	if err != nil {
		return nil, err
	}
	rows := []string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ufw ") {
			rule := strings.TrimPrefix(line, "ufw ")
			rows = append(rows, rule)
			args, e := ruleArgs(rule)
			if e != nil {
				return nil, e
			}
			// 简写的应用配置（如 OpenSSH）须查真实定义，不能按名称猜端口。
			if len(args) > 1 && !rulePort.MatchString(args[1]) && args[1] != "from" && args[1] != "to" && args[1] != "in" && args[1] != "out" && args[0] != "route" {
				profile, e := h.command(ctx, "ufw", "app", "info", args[1])
				if e != nil {
					return nil, fmt.Errorf("无法核对 UFW 应用配置 %s：%w", args[1], e)
				}
				parts := strings.SplitN(profile, "Ports:", 2)
				if len(parts) != 2 {
					parts = strings.SplitN(profile, "Port:", 2)
				}
				if len(parts) != 2 {
					return nil, fmt.Errorf("UFW 应用端口格式无效：%s", args[1])
				}
				for _, token := range strings.Fields(parts[1]) {
					if !rulePort.MatchString(token) {
						return nil, fmt.Errorf("UFW 应用端口格式无效：%s", args[1])
					}
					rows = append(rows, args[0]+" "+token+" comment 'UFW 应用配置'")
				}
			}
		}
	}
	return rows, nil
}
func (h SystemHost) AddRule(ctx context.Context, rule string) error {
	args, err := ruleArgs(rule)
	if err != nil {
		return err
	}
	_, err = h.command(ctx, "ufw", args...)
	return err
}
func (h SystemHost) DeleteRule(ctx context.Context, rule string) error {
	args, err := ruleArgs(rule)
	if err != nil {
		return err
	}
	_, err = h.command(ctx, "ufw", append([]string{"--force", "delete"}, args...)...)
	return err
}
func (h SystemHost) VerifyRules(ctx context.Context, p config.PanelNetwork) error {
	rules, err := h.Rules(ctx)
	if err != nil {
		return err
	}
	found := false
	for _, rule := range rules {
		if managedRule(rule) && ruleCovers(rule, p.FrontendPort) {
			found = true
		}
		if ruleCovers(rule, p.BackendPort) {
			return fmt.Errorf("后端端口仍存在防火墙规则")
		}
	}
	if !found {
		return fmt.Errorf("前端端口放行规则未写入")
	}
	out, err := h.command(ctx, "ufw", "status", "verbose")
	if err != nil {
		return err
	}
	if strings.Contains(out, "Status: inactive") {
		return nil
	}
	front := strconv.Itoa(p.FrontendPort) + "/tcp"
	v4, v6 := false, false
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), front+" ") && strings.Contains(line, "ALLOW IN") && strings.Contains(line, "Anywhere") {
			if strings.Contains(line, "(v6)") {
				v6 = true
			} else {
				v4 = true
			}
		}
	}
	b, err := os.ReadFile("/etc/default/ufw")
	if err != nil {
		return err
	}
	ipv6 := strings.Contains(string(b), "IPV6=yes")
	if !v4 || (ipv6 && !v6) {
		return fmt.Errorf("前端 IPv4/IPv6 放行规则未生效")
	}
	return nil
}

// Bootstrap 只注册前端规则，保持 UFW 启停状态。已安装版本的端口迁移走持久化事务。
func Bootstrap(ctx context.Context, host Host, ports config.PanelNetwork) error {
	rules, err := host.Rules(ctx)
	if err != nil {
		return err
	}
	if err = validateRules(rules, ports, ports); err != nil {
		return err
	}
	restore := func(cause error) error {
		current, e := host.Rules(ctx)
		if e == nil {
			for _, rule := range current {
				if managedRule(rule) && relevantRule(rule, ports, ports) {
					if e = host.DeleteRule(ctx, rule); e != nil {
						break
					}
				}
			}
		}
		if e == nil {
			for _, rule := range rules {
				if managedRule(rule) && relevantRule(rule, ports, ports) {
					if e = host.AddRule(ctx, rule); e != nil {
						break
					}
				}
			}
		}
		if e != nil {
			return fmt.Errorf("%w；引导规则恢复失败：%v", cause, e)
		}
		return cause
	}
	for _, rule := range rules {
		if managedRule(rule) && ruleCovers(rule, ports.BackendPort) {
			if err = host.DeleteRule(ctx, rule); err != nil {
				return restore(err)
			}
		}
	}
	if err = host.AddRule(ctx, frontendRule(ports.FrontendPort)); err != nil {
		return restore(err)
	}
	if err = host.VerifyRules(ctx, ports); err != nil {
		return restore(err)
	}
	return nil
}

type bootstrapBackup struct {
	Ports config.PanelNetwork `json:"ports"`
	Rules []string            `json:"rules"`
}

func SaveBootstrapRules(ctx context.Context, host Host, ports config.PanelNetwork, file string) error {
	rules, err := host.Rules(ctx)
	if err != nil {
		return err
	}
	if err = validateRules(rules, ports, ports); err != nil {
		return err
	}
	backup := bootstrapBackup{Ports: ports}
	for _, rule := range rules {
		if managedRule(rule) && relevantRule(rule, ports, ports) {
			backup.Rules = append(backup.Rules, rule)
		}
	}
	return config.AtomicJSON(file, backup)
}
func RestoreBootstrapRules(ctx context.Context, host Host, file string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var backup bootstrapBackup
	if err = json.Unmarshal(b, &backup); err != nil {
		return err
	}
	if err = backup.Ports.Validate(); err != nil {
		return err
	}
	rules, err := host.Rules(ctx)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		if managedRule(rule) && relevantRule(rule, backup.Ports, backup.Ports) {
			if err = host.DeleteRule(ctx, rule); err != nil {
				return err
			}
		}
	}
	for _, rule := range backup.Rules {
		if err = host.AddRule(ctx, rule); err != nil {
			return err
		}
	}
	return nil
}
func CheckInstall(ctx context.Context, store Store, host Host, ports config.PanelNetwork) error {
	rows, err := store.records()
	if err != nil {
		return err
	}
	for _, row := range rows {
		if Active(row.State) || row.State == "recovery-failed" {
			return fmt.Errorf("维护任务尚未结束，请先完成或恢复任务")
		}
	}
	return host.Preflight(ctx, ports, ports)
}
