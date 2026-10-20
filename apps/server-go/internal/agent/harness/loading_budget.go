package harness

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

const onDemandToolsV2 = "on-demand/v2"

type LoadingBudget struct {
	Estimator            string `json:"estimator"`
	SkillIndexTokens     int    `json:"skillIndexTokens"`
	ToolDefinitionTokens int    `json:"toolDefinitionTokens"`
	SkillBodyTokens      int    `json:"skillBodyTokens"`
}

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

func residentCapability(c Capability) bool {
	return c.Source == toolDiscoverySource || c.Source == userInputSource || c.Source == planSource
}
func definitionTokens(c Capability) int {
	return estimateContextText(c.Name) + estimateContextText(c.Description) + estimateContextText(string(c.Parameters)) + 8
}

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
	s.Digest = digestJSON(*s)
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

func (s CapabilitySnapshot) residentDefinitionTokens() int {
	count := 0
	for _, c := range s.Tools {
		if residentCapability(c) || contains(s.EagerTools, c.Name) {
			count += definitionTokens(c)
		}
	}
	return count
}

// 目录仅用于排序，未展示项仍在不可变目录中，可被搜索。
func (s CapabilitySnapshot) skillIndex(input string) json.RawMessage {
	if s.ToolLoading != onDemandToolsV2 || s.LoadingBudget == nil {
		raw, _ := json.Marshal(s.SkillSummaries)
		return raw
	}
	type entry struct {
		Name        string `json:"name"`
		Revision    int    `json:"revision"`
		Description string `json:"description"`
	}
	type candidate struct {
		entry entry
		score int
		id    string
	}
	candidates := []candidate{}
	terms := searchTerms(strings.ToLower(input))
	for _, skill := range s.SkillSummaries {
		score := 0
		for _, term := range terms {
			if strings.Contains(strings.ToLower(skill.Name), term) {
				score += 20
			}
			if strings.Contains(strings.ToLower(skill.Description), term) {
				score += 4
			}
		}
		description := []rune(skill.Description)
		if len(description) > 160 {
			description = description[:160]
		}
		candidates = append(candidates, candidate{entry{skill.Name, skill.Ref.Revision, string(description)}, score, skill.Ref.ID})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].id < candidates[j].id
	})
	entries := []entry{}
	raw := json.RawMessage(`[]`)
	for _, c := range candidates {
		next, _ := json.Marshal(append(entries, c.entry))
		if estimateContextText(string(next)) > s.LoadingBudget.SkillIndexTokens {
			continue
		}
		entries = append(entries, c.entry)
		raw = next
	}
	return raw
}

// 成功回执直接保存完整保留集合；不能从旧搜索重新拼出已被大小预算淘汰的定义。
func (m *Manager) loadedToolsV2(ctx context.Context, runID string, s CapabilitySnapshot) ([]string, error) {
	rows, err := m.store.db.QueryContext(ctx, `SELECT c.document FROM calls c JOIN operations o ON o.id=json_extract(c.document,'$.operationId') WHERE c.run_id=? AND o.run_id=? AND c.state='succeeded' AND o.state='completed' AND json_extract(o.document,'$.capability.source')=? AND json_extract(o.document,'$.capability.name')=? AND json_extract(o.document,'$.snapshotDigest')=? ORDER BY c.rowid DESC`, runID, runID, toolDiscoverySource, toolSearchName, s.Digest)
	if err != nil {
		return nil, storageFailure(err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var call Call
		var result toolSearchResult
		if err = rows.Scan(&raw); err != nil {
			return nil, storageFailure(err)
		}
		if err = json.Unmarshal(raw, &call); err != nil {
			return nil, storageFailure(err)
		}
		if call.Tool != toolSearchName || call.Truncated || call.Error != nil || json.Unmarshal(call.Result, &result) != nil || result.Version != onDemandToolsV2 || result.SnapshotDigest != s.Digest || result.Retained == nil || len(result.Matches) > 5 || len(result.Retained) > 16 {
			continue
		}
		byName := map[string]Capability{}
		for _, c := range s.Tools {
			byName[c.Name] = c
		}
		seen := map[string]bool{}
		total := s.residentDefinitionTokens()
		valid := true
		for _, name := range result.Retained {
			c, ok := byName[name]
			if !ok || seen[name] || residentCapability(c) || contains(s.EagerTools, name) {
				valid = false
				break
			}
			seen[name] = true
			total += definitionTokens(c)
		}
		if s.LoadingBudget == nil || total > s.LoadingBudget.ToolDefinitionTokens {
			valid = false
		}
		if valid {
			return result.Retained, nil
		}
	}
	return []string{}, storageFailure(rows.Err())
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
	return searchToolsWithBudget(s, json.RawMessage(o.ArgumentsJSON), previous)
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
	budget := s.LoadingBudget.ToolDefinitionTokens - s.residentDefinitionTokens()
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
