package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const (
	toolSearchName      = "tool_search"
	toolDiscoverySource = "tool-discovery"
	onDemandTools       = "on-demand/v1"
	eagerToolLimit      = 16
	maxLoadedTools      = 16
	maxDiscoveryCatalog = 512
)

var domainBoundaries = state.DomainBoundaries

func toolSearchCapability() Capability {
	return Capability{
		Name: toolSearchName, Source: toolDiscoverySource, ReadOnly: true,
		Description: "按任务关键词、领域或精确工具名搜索并加载已授权工具。支持中文和英文，如容器列表、数据库、文件、日志、网站、技能、MCP、Bash。每次最多 5 项，匹配工具从下一次模型请求起可调用；搜索不执行实际操作。同一子目标最多连续搜索两次；无匹配或结果不适用时按目录摘要的 notes 能力边界判断，不要反复换词，用 nextOffset 继续分页。",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":256},"limit":{"type":"integer","minimum":1,"maximum":5},"offset":{"type":"integer","minimum":0,"maximum":512}},"required":["query"],"additionalProperties":false}`),
		Metadata:    tools.Metadata{Domain: "tools", Action: "search", Effect: "read", Exposure: "agent", Backend: "store", Version: "1", ReadOnly: true},
	}
}

type toolSearchArgs struct {
	Query  string `json:"query"`
	Limit  *int   `json:"limit,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

func parseToolSearch(raw json.RawMessage) (toolSearchArgs, error) {
	var args toolSearchArgs
	if err := mcp.Validate(toolSearchCapability().Parameters, raw); err != nil {
		return args, err
	}
	if err := json.Unmarshal(raw, &args); err != nil || strings.TrimSpace(args.Query) == "" || utf8.RuneCountInString(args.Query) > 256 || args.Offset < 0 || args.Offset > maxDiscoveryCatalog || (args.Limit != nil && (*args.Limit < 1 || *args.Limit > 5)) {
		return args, bad("invalid-tool-search", "工具搜索需要非空关键词，limit 为 1 到 5，offset 为 0 到 512")
	}
	return args, nil
}

type toolSearchMatch struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Domain      string `json:"domain"`
	ReadOnly    bool   `json:"readOnly"`
}

type toolSearchResult struct {
	Loaded          []string            `json:"loaded"`
	Retained        []string            `json:"retained"`
	Skipped         []toolSearchSkipped `json:"skipped,omitempty"`
	Evicted         []string            `json:"evicted,omitempty"`
	BudgetTokens    int                 `json:"budgetTokens,omitempty"`
	EstimatedTokens int                 `json:"estimatedTokens,omitempty"`
	Version         string              `json:"version"`
	SnapshotDigest  string              `json:"snapshotDigest"`
	Matches         []toolSearchMatch   `json:"matches"`
	Total           int                 `json:"total"`
	NextOffset      *int                `json:"nextOffset,omitempty"`
	// Note 在结果已穷尽时给出停止搜索的明确信号，避免模型换关键词反复搜索同一目标。
	Note string `json:"note,omitempty"`
}

// 搜索只读取本轮固定目录；技能内容、模型参数和外部结果不能扩展候选集。
func searchTools(snapshot CapabilitySnapshot, raw json.RawMessage) (CapabilityResult, error) {
	args, err := parseToolSearch(raw)
	if err != nil {
		return CapabilityResult{}, err
	}
	limit := 3
	if args.Limit != nil {
		limit = *args.Limit
	}
	var candidates []toolSearchCandidate
	query := strings.ToLower(strings.TrimSpace(args.Query))
	terms := searchTerms(query)
	exact := false
	for _, c := range snapshot.Tools {
		if c.Source != toolDiscoverySource && c.Source != userInputSource && c.Source != planSource && c.Source != taskHistorySource && (strings.ToLower(c.Name) == query || strings.ToLower(c.OriginalName) == query) {
			exact = true
			break
		}
	}
	for _, c := range snapshot.Tools {
		if c.Source == toolDiscoverySource || c.Source == userInputSource || c.Source == planSource || c.Source == taskHistorySource {
			continue
		}
		if exact && strings.ToLower(c.Name) != query && strings.ToLower(c.OriginalName) != query {
			continue
		}
		name := strings.ToLower(c.Name + " " + c.OriginalName + " " + strings.Join(c.SearchNames, " "))
		text := strings.ToLower(c.Description)
		domain := strings.ToLower(c.Metadata.Domain + " " + c.Source + " " + discoveryDomainKeywords(c.Metadata.Domain, c.Source))
		score := 0
		if exact {
			score += 10000
		}
		// 只给领域泛查的本地清单入口提权重，避免先返回异步任务观察工具。
		if query == strings.ToLower(c.Metadata.Domain) && discoveryReadList(c) {
			score += 16
		}
		for _, term := range terms {
			if strings.Contains(name, term) {
				score += 20
			}
			if strings.Contains(domain, term) {
				score += 8
			}
			if strings.Contains(text, term) {
				score += 4
			}
		}
		if score > 0 {
			candidates = append(candidates, toolSearchCandidate{c, score})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		// 同等相关时先给只读清单入口，泛问“有什么镜像”无需先知道单项 ID。
		if left, right := discoveryReadList(candidates[i].capability), discoveryReadList(candidates[j].capability); left != right {
			return left
		}
		return candidates[i].capability.Name < candidates[j].capability.Name
	})
	result := toolSearchResult{Version: onDemandTools, SnapshotDigest: snapshot.Digest, Matches: []toolSearchMatch{}, Total: len(candidates)}
	end := min(args.Offset+limit, len(candidates))
	for i := args.Offset; i < end; i++ {
		c := candidates[i].capability
		description := []rune(c.Description)
		if len(description) > 240 {
			description = description[:240]
		}
		result.Matches = append(result.Matches, toolSearchMatch{Name: c.Name, Description: string(description), Domain: c.Metadata.Domain, ReadOnly: c.ReadOnly})
	}
	if end < len(candidates) {
		result.NextOffset = &end
	} else if len(candidates) == 0 {
		result.Note = "该关键词没有任何匹配；按目录摘要的 notes 能力边界判断该能力是否提供，不要换关键词反复搜索同一目标，必要时用现有工具作答并明确说明该能力或数据不可得。"
	} else {
		result.Note = fmt.Sprintf("已返回该关键词的全部 %d 项匹配；若都不能回答当前问题，请按目录摘要的 notes 判断该能力是否提供，不要换关键词反复搜索同一目标，必要时用现有工具作答并明确说明该能力或数据不可得。", len(candidates))
	}
	value, err := json.Marshal(result)
	return CapabilityResult{Value: value}, err
}

type toolSearchCandidate struct {
	capability Capability
	score      int
}

func discoveryReadList(c Capability) bool {
	return c.ReadOnly && (c.Metadata.Action == "list" || strings.HasSuffix(c.Name, "_list"))
}

var searchTerms = state.SearchTerms

func discoveryDomainKeywords(domain, source string) string {
	aliases := map[string]string{
		"docker": "容器 镜像", "files": "文件 目录",
		"database": "数据库 实例 建库 账号 部署 MySQL MariaDB Redis",
		"security": "安全 用户 登录 SSH", "firewall": "防火墙 连接 端口", "logs": "日志",
		"platform": "平台 系统 面板 占用 性能 资源 内存 RSS CPU 负载 磁盘 依赖", "panel": "面板 更新", "website": "网站 站点 部署 证书",
		"container-app": "容器 应用 工作区 构建", "workspace": "任务 工作区 文件", "web": "网页 网址 URL HTTP HTTPS fetch 访问 读取 浏览",
		"skill-load": "技能 SKILL 资料", "script": "技能 脚本", "bash": "命令 脚本 执行",
		"mcp-tool": "MCP 扩展", "mcp-resource": "MCP 资料 资源",
	}
	return aliases[domain] + " " + aliases[source]
}

func (a *agentExecution) onDemandTools() bool {
	return a.run.DriverVersion == "v2" && a.run.Snapshot != nil && (a.run.Snapshot.ToolLoading == onDemandTools || a.run.Snapshot.ToolLoading == onDemandToolsV2)
}

// 从已确认的内核搜索回执恢复可见集，不依赖会被整理的消息窗口或模型工作记忆。
func (a *agentExecution) loadedToolNames(ctx context.Context) (map[string]bool, error) {
	loaded := map[string]bool{}
	rows, err := readView(ctx, a.manager.store).LoadedToolHistory(ctx, a.run.ID, toolDiscoverySource, a.run.Snapshot.Digest)
	if err != nil {
		return nil, storageFailure(err)
	}

	allowed := map[string]bool{}
	for _, c := range a.run.Snapshot.Tools {
		allowed[c.Name] = c.Source != toolDiscoverySource
	}
	for _, record := range rows {
		var raw []byte
		var call Call
		var result toolSearchResult
		raw = record.Document
		if err := json.Unmarshal(raw, &call); err != nil {
			return nil, storageFailure(err)
		}
		if call.Tool != toolSearchName || call.Truncated || call.Error != nil || json.Unmarshal(call.Result, &result) != nil || result.Version != onDemandTools || result.SnapshotDigest != a.run.Snapshot.Digest || len(result.Matches) > 5 {
			continue
		}
		for _, match := range result.Matches {
			if allowed[match.Name] {
				loaded[match.Name] = true
				if len(loaded) == maxLoadedTools {
					return loaded, nil
				}
			}
		}
	}
	return loaded, nil
}

func (a *agentExecution) validateVisibleProposal(record ModelRequestRecord, name string) error {
	if !a.onDemandTools() || record.Purpose != "inference" {
		return nil
	}
	if !contains(record.ToolNames, name) {
		return bad("tool-not-loaded", "模型请求了本次尚未加载的工具，请先通过 tool_search 搜索并在下一次请求中调用")
	}
	return nil
}
