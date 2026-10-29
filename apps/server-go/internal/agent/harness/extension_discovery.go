package harness

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

type ExtensionUnavailable struct {
	Kind     string `json:"kind"`
	ID       string `json:"id,omitempty"`
	Revision int    `json:"revision,omitempty"`
	Code     string `json:"code"`
	Reason   string `json:"reason"`
}

type AutomaticExtensions struct {
	Source      string                 `json:"source"`
	Skills      []RevisionRef          `json:"skills"`
	Servers     []RevisionRef          `json:"servers"`
	Unavailable []ExtensionUnavailable `json:"unavailable"`
}

// 自动目录不写回会话环境；原环境仍是执行配置、grant、资料和信任的唯一来源。
func (m *Manager) snapshotForAgent(ctx context.Context, env Environment, mode string, authorizationModes ...string) (CapabilitySnapshot, error) {
	ctx = context.WithValue(ctx, wikiDisabledContextKey{}, true)
	env = m.withDockerTools(env)
	// 新接受的普通聊天统一获得公网读取能力；不回写旧环境或已接受 Run。
	if m.deps.Tools != nil && !contains(env.Tools, "web_fetch") {
		for _, schema := range m.deps.Tools.Schemas() {
			if schema.Name == "web_fetch" && schema.Metadata.Domain == "web" && schema.Metadata.Exposure == "agent" && schema.Metadata.ReadOnly {
				env.Tools = append(append([]string{}, env.Tools...), schema.Name)
				break
			}
		}
	}
	if len(authorizationModes) > 0 && authorizationModes[0] == AuthorizationOnDemand {
		ctx = context.WithValue(ctx, runtimeAccessContextKey{}, true)
		env.ExecutionProfiles, env.Grants = nil, nil
		if e, ok := m.deps.Catalog.(*Extensions); ok {
			for _, name := range []string{BashExec, BashScript} {
				if e.Executor != nil && e.Workspaces != nil && !contains(env.Tools, name) {
					env.Tools = append(append([]string{}, env.Tools...), name)
				}
			}
		}
	}
	selected := env
	if _, local := m.deps.Catalog.(*Extensions); local && mode == "enabled" {
		// 技能和工具按最新修订组装；旧服务引用仅用于显式资料和提示模板。
		if len(env.Skills) > 32 {
			return CapabilitySnapshot{}, bad("environment-limit", "会话技能条目超过限制")
		}
		seen := map[string]bool{}
		for _, ref := range env.Skills {
			if ref.ID == "" || ref.Revision < 1 || seen[ref.ID] {
				return CapabilitySnapshot{}, bad("duplicate-environment-ref", "环境技能编号必须唯一且固定具体修订")
			}
			seen[ref.ID] = true
		}
		selected.Skills, selected.Tools, selected.TrustedReadOnly = nil, nil, nil
		automaticName := func(name string) bool {
			return strings.HasPrefix(name, "mcp_") || strings.HasPrefix(name, "skill_") || strings.HasPrefix(name, "script_")
		}
		for _, name := range env.Tools {
			if !automaticName(name) {
				selected.Tools = append(selected.Tools, name)
			}
		}
		for _, name := range env.TrustedReadOnly {
			if !automaticName(name) {
				selected.TrustedReadOnly = append(selected.TrustedReadOnly, name)
			}
		}
	}
	s, err := m.snapshotWithMode(ctx, selected, true)
	if runtimeAccessEnabled(ctx) {
		s.AuthorizationMode = AuthorizationOnDemand
	}
	if err != nil || mode != "enabled" {
		return s, err
	}
	fixedServers := s.Environment.Servers
	s.Environment = env
	s.Environment.Servers = fixedServers
	automatic := &AutomaticExtensions{Source: "enabled", Skills: []RevisionRef{}, Servers: []RevisionRef{}, Unavailable: []ExtensionUnavailable{}}
	s.Automatic = automatic
	unavailable := func(kind string, ref RevisionRef, code, reason string) {
		automatic.Unavailable = append(automatic.Unavailable, ExtensionUnavailable{Kind: kind, ID: ref.ID, Revision: ref.Revision, Code: code, Reason: reason})
	}
	e, ok := m.deps.Catalog.(*Extensions)
	if !ok {
		unavailable("skill", RevisionRef{}, "skill-unavailable", "技能存储未就绪")
		unavailable("mcp", RevisionRef{}, "mcp-unavailable", "MCP 配置未就绪")
		return s, nil
	}
	kept := make([]Capability, 0, len(s.Tools))
	for _, c := range s.Tools {
		if c.Source != "skill-load" && c.Source != "script" && c.Source != "mcp-tool" {
			kept = append(kept, c)
		}
	}
	s.Tools, s.SkillSummaries = kept, nil
	// 单个候选只借用已有执行授权，不把扩展配置中的 grant 自动加入环境。
	base := Environment{ExecutionProfiles: env.ExecutionProfiles, Grants: env.Grants}
	if e.Skills == nil || e.SkillsReason != "" {
		unavailable("skill", RevisionRef{}, "skill-unavailable", "技能配置不可用")
	} else {
		rows, readErr := e.Skills.List()
		if readErr != nil {
			unavailable("skill", RevisionRef{}, "skill-unavailable", "技能配置不可用")
		} else {
			sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
			for _, skill := range rows {
				if !skill.Enabled {
					continue
				}
				ref := RevisionRef{ID: skill.ID, Revision: skill.Revision, Digest: skill.Digest}
				revoked, err := m.extensionRevoked(ctx, "skill", ref)
				if err != nil {
					return s, err
				}
				if revoked {
					unavailable("skill", ref, "capability-revoked", "技能修订已撤销")
					continue
				}
				selected := base
				selected.Skills = []RevisionRef{ref}
				part, err := e.snapshot(ctx, selected, true)
				if err != nil {
					if typed, ok := err.(*Error); ok && (typed.Code == "snapshot-limit" || typed.Code == "environment-limit") {
						return s, err
					}
					unavailable("skill", ref, "skill-unavailable", "技能配置或必要执行依赖不可用")
					continue
				}
				automatic.Skills = append(automatic.Skills, ref)
				s.SkillSummaries = append(s.SkillSummaries, part.SkillSummaries...)
				s.Tools = append(s.Tools, part.Tools...)
			}
		}
	}
	if e.Servers == nil || e.MCP == nil || e.MCPReason != "" {
		unavailable("mcp", RevisionRef{}, "mcp-unavailable", "MCP 配置或连接组件不可用")
	} else {
		rows := e.Servers.List()
		sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
		for _, server := range rows {
			if !server.Active {
				continue
			}
			ref := RevisionRef{ID: server.ID, Revision: server.Revision}
			revoked, err := m.extensionRevoked(ctx, "mcp", ref)
			if err != nil {
				return s, err
			}
			if revoked || server.Revoked {
				unavailable("mcp", ref, "capability-revoked", "MCP 服务修订已撤销")
				continue
			}
			catalog, err := e.Servers.Catalog(ref.ID, ref.Revision, "")
			if err != nil {
				unavailable("mcp", ref, "mcp-catalog-unavailable", "该修订没有可用的已保存探测目录，请手动探测")
				continue
			}
			ref.Digest = catalog.Digest
			if server.Stdio != nil {
				if e.Executor == nil || e.ExecutionReason != "" {
					unavailable("mcp", ref, "execution-unavailable", "stdio 执行器不可用")
					continue
				}
				if server.Stdio.GrantID != "" && !runtimeAccessEnabled(ctx) {
					granted := false
					for _, g := range s.Grants {
						if g.ID == server.Stdio.GrantID && g.Revision == server.Stdio.GrantRevision {
							revoked, err := m.extensionRevoked(ctx, "grant", RevisionRef{ID: g.ID, Revision: g.Revision})
							if err != nil {
								return s, err
							}
							granted = !revoked
						}
					}
					if !granted {
						unavailable("mcp", ref, "mcp-grant-denied", "stdio 所需固定授权未选入会话或已撤销")
						continue
					}
				}
			}
			automatic.Servers = append(automatic.Servers, ref)
			for _, tool := range catalog.Tools {
				s.Tools = append(s.Tools, Capability{Name: capabilityAlias("mcp", ref.ID, tool.Name), Description: tool.Description, Parameters: tool.InputSchema, OutputSchema: tool.OutputSchema, Source: "mcp-tool", Ref: ref, OriginalName: tool.Name, CatalogDigest: catalog.Digest, SearchNames: []string{server.Name, tool.Name}})
			}
		}
	}
	// 手选能力失效不能因自动目录跳过候选而被悄悄忽略。
	for _, ref := range env.Skills {
		found := false
		for _, actual := range automatic.Skills {
			found = found || actual.ID == ref.ID
		}
		if !found {
			return s, bad("skill-unavailable", "显式选择的技能在最新自动目录中不可用")
		}
	}
	for _, name := range env.Tools {
		found := false
		for _, c := range s.Tools {
			found = found || c.Name == name
		}
		if !found {
			return s, bad("tool-unavailable", "显式选择的工具在最新自动目录中不可用")
		}
	}
	if len(automatic.Skills) > 32 || len(automatic.Servers) > 32 {
		return s, bad("environment-limit", "自动扩展目录超过 32 个技能或 MCP 服务的上限")
	}
	// 自动目录与手选目录按稳定 ID/别名合并计数，不以来源绕过原选择上限。
	serverIDs, selectedTools := map[string]bool{}, map[string]bool{}
	for _, ref := range env.Servers {
		serverIDs[ref.ID] = true
	}
	for _, ref := range automatic.Servers {
		serverIDs[ref.ID] = true
	}
	for _, name := range env.Tools {
		selectedTools[name] = true
	}
	for _, c := range s.Tools {
		if c.Source == "mcp-tool" {
			selectedTools[c.Name] = true
		}
	}
	if len(serverIDs) > 32 || len(selectedTools) > 128 {
		return s, bad("environment-limit", "合并目录超过 32 个 MCP 服务或 128 个工具选择的上限")
	}
	if err := validateSnapshotLimits(s); err != nil {
		return s, err
	}
	return s, nil
}

func (m *Manager) extensionRevoked(ctx context.Context, kind string, ref RevisionRef) (bool, error) {
	var count int
	err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", kind, ref.ID, ref.Revision).Scan(&count)
	return count > 0, storageFailure(err)
}

func validateSnapshotLimits(s CapabilitySnapshot) error {
	extensions, total := 0, 0
	names := map[string]bool{}
	for _, c := range s.Tools {
		if names[c.Name] {
			return bad("duplicate-capability", "能力别名重复")
		}
		names[c.Name] = true
		if residentCapability(c) {
			continue
		}
		total++
		if c.Source != "builtin" && c.Source != "wiki" {
			extensions++
		}
	}
	raw, err := json.Marshal(s)
	if err != nil || len(raw) > 4<<20 || extensions > 256 || len(s.Materials) > 128 {
		return bad("snapshot-limit", "能力快照超过 4 MiB、256 个扩展工具或 128 个提示模板的上限")
	}
	if total > maxDiscoveryCatalog {
		return bad("capability-limit", "运行固定工具目录不能超过 512 项")
	}
	return nil
}
