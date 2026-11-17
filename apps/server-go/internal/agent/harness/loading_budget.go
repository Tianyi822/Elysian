package harness

import (
	"context"
	"encoding/json"

	"elysian/server/internal/agent/harness/state"
)

// loadingBudget 以模型声明容量减去输出上限后的输入空间（token）按固定比例切分。
// 工具定义与技能材料的计量仍用 estimateContextText 的 local-text/v1 本地近似：
// 它直接按文本字符估算 token，与提示词字节比例（token_estimate.go 的官方锚点校准）
// 口径不同，不能把 prompt 反推比例套到 JSON Schema 上，否则会随请求内容变化而漂移。
func loadingBudget(run Run, level string) LoadingBudget {
	a := agentExecution{run: run}
	input := 0
	if run.Model != nil {
		input = max(0, run.Model.ContextTokens-a.outputLimit(level))
	}
	return LoadingBudget{Estimator: "local-text/v1", SkillIndexTokens: min(2048, input/16), ToolDefinitionTokens: min(8192, input/8), SkillBodyTokens: min(16384, input/4)}
}

var residentCapability = state.ResidentCapability
var definitionTokens = state.DefinitionTokens

// 只给新快照写入 v2；恢复路径不重算、不补写旧快照。
func finalizeLoading(s *CapabilitySnapshot, run Run, level string, original Environment) error {
	kept := make([]Capability, 0, len(s.Tools)+1)
	for _, c := range s.Tools {
		if c.Source == toolDiscoverySource {
			continue
		}
		if c.Source == "mcp-tool" || c.Source == "mcp-resource" || c.Source == "mcp-prompt" {
			c.ReadOnly = exactMCPTrust(original, c)
		}
		kept = append(kept, c)
	}
	s.Tools = append(kept, toolSearchCapability())
	for i := range s.Materials {
		if s.Materials[i].Source == "mcp-prompt" {
			s.Materials[i].ReadOnly = exactMCPTrust(original, s.Materials[i])
		}
	}
	return configureLoadingBudget(s, run, level)
}

func configureLoadingBudget(s *CapabilitySnapshot, run Run, level string) error {
	budget := loadingBudget(run, level)
	s.ToolLoading, s.LoadingBudget = onDemandToolsV2, &budget
	s.EagerTools = nil
	resident, builtin := 0, 0
	var eager []string
	for _, c := range s.Tools {
		if residentCapability(c) {
			resident += definitionTokens(c)
		}
		if c.Source == "builtin" || c.Source == "workspace" || c.Source == "wiki" || isBashSource(c.Source) {
			builtin += definitionTokens(c)
			eager = append(eager, c.Name)
		}
	}
	if resident > budget.ToolDefinitionTokens {
		return bad("tool-definition-budget", "模型输入空间不足以容纳常驻工具定义，请切换容量更大的模型")
	}
	if len(eager) <= eagerToolLimit && resident+builtin <= budget.ToolDefinitionTokens {
		s.EagerTools = eager
	}
	s.Digest = ""
	if err := validateSnapshotLimits(*s); err != nil {
		return err
	}
	s.Digest = state.DigestJSON(*s)
	return nil
}

func exactMCPTrust(env Environment, c Capability) bool {
	if !contains(env.TrustedReadOnly, c.Name) {
		return false
	}
	for _, ref := range env.Servers {
		if ref.ID == c.Ref.ID && ref.Revision == c.Ref.Revision && ref.Digest != "" && ref.Digest == c.CatalogDigest {
			return true
		}
	}
	return false
}

type loadedToolState struct {
	Retained []string // 搜索回执中的保留顺序，用于下一次搜索的预算淘汰。
	Order    []string // 定义首次加载顺序；淘汰后重新加载追加到尾部。
}

// loadedToolsV2 从同一次读取恢复可见集合和定义顺序。
func (m *Manager) loadedToolsV2(ctx context.Context, runID string, s CapabilitySnapshot) (loadedToolState, error) {
	rows, err := readView(ctx, m.store).ToolLoadHistory(ctx, runID, toolDiscoverySource, toolSearchName, s.Digest)
	if err != nil {
		return loadedToolState{}, storageFailure(err)
	}

	var calls []Call
	for _, record := range rows {
		var raw []byte
		var call Call
		raw = record.Document
		if err = json.Unmarshal(raw, &call); err != nil {
			return loadedToolState{}, storageFailure(err)
		}
		calls = append(calls, call)
	}
	return projectLoadedTools(s, calls), nil
}

// projectLoadedTools 只折叠固定目录下的有效搜索回执，保留集合和顺序共同推进。
func projectLoadedTools(s CapabilitySnapshot, calls []Call) loadedToolState {
	state := loadedToolState{Retained: []string{}}
	byName := make(map[string]Capability, len(s.Tools))
	for _, c := range s.Tools {
		byName[c.Name] = c
	}
	for _, call := range calls {
		var result toolSearchResult
		if call.Tool != toolSearchName || call.Truncated || call.Error != nil || json.Unmarshal(call.Result, &result) != nil || result.Version != onDemandToolsV2 || result.SnapshotDigest != s.Digest || result.Retained == nil || len(result.Matches) > 5 || len(result.Retained) > maxLoadedTools {
			continue
		}
		current := make(map[string]bool, len(result.Retained))
		total := s.ResidentDefinitionTokens()
		valid := true
		for _, name := range result.Retained {
			c, ok := byName[name]
			if !ok || current[name] || residentCapability(c) || contains(s.EagerTools, name) {
				valid = false
				break
			}
			current[name] = true
			total += definitionTokens(c)
		}
		if !valid || s.LoadingBudget == nil || total > s.LoadingBudget.ToolDefinitionTokens {
			continue
		}
		order := make([]string, 0, len(result.Retained))
		for _, name := range state.Order {
			if current[name] {
				order = append(order, name)
				delete(current, name)
			}
		}
		for _, name := range result.Retained {
			if current[name] {
				order = append(order, name)
			}
		}
		state = loadedToolState{Retained: result.Retained, Order: order}
	}
	return state
}

type toolSearchSkipped struct {
	Name            string `json:"name"`
	Reason          string `json:"reason"`
	EstimatedTokens int    `json:"estimatedTokens"`
}

func (m *Manager) searchToolsV2(ctx context.Context, s CapabilitySnapshot, o Operation) (CapabilityResult, error) {
	previous, err := m.loadedToolsV2(ctx, o.RunID, s)
	if err != nil {
		return CapabilityResult{}, err
	}
	return searchToolsWithBudget(s, json.RawMessage(o.ArgumentsJSON), previous.Retained)
}
func searchToolsWithBudget(s CapabilitySnapshot, args json.RawMessage, previous []string) (CapabilityResult, error) {
	raw, err := searchTools(s, args)
	if err != nil {
		return raw, err
	}
	var result toolSearchResult
	if err = json.Unmarshal(raw.Value, &result); err != nil {
		return CapabilityResult{}, err
	}
	result.Version = onDemandToolsV2
	result.Retained = []string{}
	result.Loaded = []string{}
	byName := map[string]Capability{}
	for _, c := range s.Tools {
		byName[c.Name] = c
	}
	budget := s.LoadingBudget.ToolDefinitionTokens - s.ResidentDefinitionTokens()
	seen := map[string]bool{}
	for _, match := range result.Matches {
		c := byName[match.Name]
		if contains(s.EagerTools, c.Name) {
			result.Loaded = append(result.Loaded, c.Name)
			continue
		}
		cost := definitionTokens(c)
		if cost > budget {
			result.Skipped = append(result.Skipped, toolSearchSkipped{c.Name, "完整定义超过剩余工具预算", cost})
			continue
		}
		budget -= cost
		seen[c.Name] = true
		result.Loaded = append(result.Loaded, c.Name)
		result.Retained = append(result.Retained, c.Name)
	}
	for _, name := range previous {
		if seen[name] {
			continue
		}
		c, ok := byName[name]
		if !ok {
			continue
		}
		cost := definitionTokens(c)
		if len(result.Retained) < maxLoadedTools && cost <= budget {
			budget -= cost
			seen[name] = true
			result.Retained = append(result.Retained, name)
		} else {
			result.Evicted = append(result.Evicted, name)
		}
	}
	result.BudgetTokens = s.LoadingBudget.ToolDefinitionTokens
	result.EstimatedTokens = s.LoadingBudget.ToolDefinitionTokens - budget
	raw.Value, err = json.Marshal(result)
	return raw, err
}

// 工作流候选目录来自已接受实例；仅在创建步骤 Run 时按该步骤输出预留固定预算。
func prepareWorkflowRunLoading(run *Run) {
	if run.Snapshot == nil || run.Snapshot.ToolLoading != onDemandToolsV2 {
		return
	}
	level := ""
	if run.Selection != nil {
		level = run.Selection.ReasoningLevel
	}
	copy := *run.Snapshot
	if err := configureLoadingBudget(&copy, *run, level); err != nil {
		run.Status, run.Phase, run.EndedAt, run.EndReason = StateFailed, "completed", run.CreatedAt, "tool-definition-budget"
		run.Error = &Failure{Code: "tool-definition-budget", Message: "工作流步骤模型输入空间不足以容纳常驻工具"}
		return
	}
	run.Snapshot = &copy
}

const onDemandToolsV2 = state.OnDemandToolsV2
