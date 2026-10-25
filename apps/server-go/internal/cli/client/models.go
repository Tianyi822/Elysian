package client

import (
	"context"
	"slices"
)

// 模型目录与思考等级推导（CLI 方案 §6.3）：TUI 的模型选择只列 active 且支持文本与
// 工具调用的修订（与 harness 会话创建校验 sessions.go 同口径）；思考等级只取模型
// 声明档位，默认档策略与 Web 侧一致（声明默认档优先，未声明时优先 high，其次
// medium，否则首项），未声明推理档位的模型不提供选择。

// ListModelProfiles 拉取全部模型配置公开副本。
func (c *Client) ListModelProfiles(ctx context.Context) ([]ModelProfile, error) {
	var profiles []ModelProfile
	_, err := c.do(ctx, "GET", "/api/agent/model-profiles", nil, nil, &profiles, "")
	return profiles, err
}

// ChatModels 过滤出会话可选模型：active 且 capabilities.text 与 capabilities.tools
// 同时成立（service 联动状态已折叠进 profile.active）。
func ChatModels(profiles []ModelProfile) []ModelProfile {
	usable := make([]ModelProfile, 0, len(profiles))
	for _, profile := range profiles {
		if profile.Active && profile.Capabilities.Text && profile.Capabilities.Tools {
			usable = append(usable, profile)
		}
	}
	return usable
}

// DefaultReasoningLevel 推导默认思考档：声明默认档（须在档位表内）优先，否则 high、
// medium、首项依次回落；模型未声明任何档位时返回空串（不补造档位）。
func DefaultReasoningLevel(levels []string, declared string) string {
	if len(levels) == 0 {
		return ""
	}
	if declared != "" && slices.Contains(levels, declared) {
		return declared
	}
	for _, preferred := range []string{"high", "medium"} {
		if slices.Contains(levels, preferred) {
			return preferred
		}
	}
	return levels[0]
}

// ReasoningLabel 思考档位中文标签（与 Web 侧 REASONING_LABELS 同表；未知档位回原文）。
func ReasoningLabel(level string) string {
	labels := map[string]string{
		"disabled": "关闭",
		"none":     "关闭",
		"minimal":  "极低",
		"low":      "低",
		"medium":   "中",
		"high":     "高",
		"xhigh":    "极高",
		"max":      "最高",
		"ultra":    "超高",
	}
	if label, ok := labels[level]; ok {
		return label
	}
	return level
}
