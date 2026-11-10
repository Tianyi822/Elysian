package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"time"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/termui"
)

func upgradeResourcesSummary(r client.PanelUpdatePreflight) string {
	mib := func(v uint64) uint64 { return v / 1024 / 1024 }
	return fmt.Sprintf("可用内存：%d MiB / 构建门槛 %d MiB（总内存 %d MiB）\nswap：可用 %d / %d MiB（不计入门槛）\n磁盘可用：%d MiB\n负载：%.2f / %.2f / %.2f\n非终态 Agent 运行：%d\n更新后恢复本次临时停止的业务；Agent 保留中断记录，由用户手动继续。", mib(r.Memory.AvailableBytes), mib(r.Memory.RequiredBytes), mib(r.Memory.TotalBytes), mib(r.Memory.SwapFreeBytes), mib(r.Memory.SwapTotalBytes), mib(r.Disk.AvailableBytes), r.Load[0], r.Load[1], r.Load[2], r.ActiveAgentRuns)
}

func selectUpgradeResources(r client.PanelUpdatePreflight, opts upgradeOptions, stdin *os.File, stdout io.Writer, interactive bool) (*client.PanelResourcePlan, int, error) {
	expiry, err := time.Parse(time.RFC3339Nano, r.ExpiresAt)
	if err != nil || r.ID == "" || r.Memory.RequiredBytes == 0 || r.Memory.TotalBytes == 0 || r.Memory.AvailableBytes > r.Memory.TotalBytes || r.Memory.SwapFreeBytes > r.Memory.SwapTotalBytes {
		return nil, 1, errors.New("更新资源预检响应无效，未提交更新")
	}
	if time.Now().After(expiry) {
		return nil, 1, errors.New("更新资源预检已过期，请重新运行更新")
	}
	fmt.Fprintln(stdout, upgradeResourcesSummary(r))
	if r.BlockedReason != "" {
		return nil, 1, errors.New(r.BlockedReason)
	}
	available := map[string]client.PanelResourceCandidate{}
	for _, c := range r.Candidates {
		_, duplicate := available[c.ID]
		valid := c.Kind == "container" && regexp.MustCompile(`^container:[a-f0-9]{64}$`).MatchString(c.ID) || c.Kind == "service" && regexp.MustCompile(`^service:[A-Za-z0-9_.@:-]+\.service$`).MatchString(c.ID)
		if !valid || duplicate {
			return nil, 1, errors.New("更新预检停机清单响应无效，未提交更新")
		}
		available[c.ID] = c
	}
	selected := map[string]bool{}
	explicit := opts.StopPanel || len(opts.StopContainers)+len(opts.StopServices) > 0
	for _, id := range opts.StopContainers {
		selected["container:"+id] = true
	}
	for _, id := range opts.StopServices {
		selected["service:"+id] = true
	}
	for id := range selected {
		candidate, ok := available[id]
		if !ok {
			return nil, 1, fmt.Errorf("停机对象不在当前预检清单：%s", id)
		}
		if candidate.DisabledReason != "" {
			return nil, 1, fmt.Errorf("不能停止 %s：%s", id, candidate.DisabledReason)
		}
	}
	plan := &client.PanelResourcePlan{PreflightID: r.ID, Targets: []string{}, StopPanel: opts.StopPanel}
	if !interactive && r.NeedsRelease && !explicit {
		fmt.Fprintln(stdout, "当前内存不足。建议停机对象：")
		if r.StopPanelRecommended {
			fmt.Fprintln(stdout, "  --stop-panel（构建期间面板与 Agent 离线）")
		}
		for _, c := range r.Candidates {
			if c.Recommended && c.DisabledReason == "" {
				fmt.Fprintf(stdout, "  --stop-%s %s（%s）\n", c.Kind, c.ID[len(c.Kind)+1:], termui.Safe(c.Name))
			}
		}
		return nil, 1, errors.New("--yes 不授权停止业务；请明确提供 --stop-container、--stop-service 或 --stop-panel 后重试")
	}
	if interactive && (r.NeedsRelease || explicit) {
		if !explicit {
			plan.StopPanel = r.StopPanelRecommended
			for _, c := range r.Candidates {
				if c.Recommended && c.DisabledReason == "" {
					selected[c.ID] = true
				}
			}
		}
		for {
			mark := func(v bool) string {
				if v {
					return "[✓] "
				}
				return "[ ] "
			}
			items := []string{"取消更新", "确认上述停机范围", mark(plan.StopPanel) + "面板及 Agent（构建期间离线）"}
			for _, c := range r.Candidates {
				memory := "占用未知"
				if c.MemoryBytes != nil {
					memory = fmt.Sprintf("%d MiB", *c.MemoryBytes/1024/1024)
				}
				label := mark(selected[c.ID]) + termui.Safe(c.Name) + " · " + memory + " · " + c.ID
				if c.DisabledReason != "" {
					label += " · 不可选择：" + termui.Safe(c.DisabledReason)
				}
				items = append(items, label)
			}
			choice, code := chooseUpgrade(stdin, stdout, "更新停机清单", upgradeResourcesSummary(r)+"\n\n切换清单项后再选择确认。只授权当前选定对象，不会额外停止其他业务。", items, nil)
			if code != 0 {
				return nil, code, nil
			}
			if choice <= 0 {
				return nil, 0, nil
			}
			if choice == 1 {
				break
			}
			if choice == 2 {
				plan.StopPanel = !plan.StopPanel
				continue
			}
			c := r.Candidates[choice-3]
			if c.DisabledReason == "" {
				selected[c.ID] = !selected[c.ID]
			}
		}
	}
	for id, yes := range selected {
		if yes {
			plan.Targets = append(plan.Targets, id)
		}
	}
	sort.Strings(plan.Targets)
	if time.Now().After(expiry) {
		return nil, 1, errors.New("更新资源预检已过期，未提交更新；请重新检查")
	}
	if plan.StopPanel {
		fmt.Fprintln(stdout, "已允许提前停止面板及 Agent；构建期间连接会暂时中断。")
	}
	for _, id := range plan.Targets {
		fmt.Fprintln(stdout, "已允许临时停止：", termui.Safe(id))
	}
	return plan, 0, nil
}
