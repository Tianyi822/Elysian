package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/jsonvalue"
)

func resourceText(s string, max int) bool {
	return s != "" && len(s) <= max && utf8.ValidString(s) && !strings.ContainsAny(s, "\x00\r\n\t") && strings.TrimSpace(s) == s
}

func validateResourceRule(in ResourceRuleInput) error {
	s := in.Selector
	if !resourceText(in.Name, 160) || (s.Source != "mcp-tool" && s.Source != "mcp-resource" && s.Source != "mcp-prompt" && s.Source != "script") || !requestPattern.MatchString(s.Ref.ID) || s.Ref.Revision < 1 || len(in.Mappings) > 32 || len(in.Mappings) == 0 {
		return bad("invalid-resource-rule", "资源规则必须固定能力来源、修订及 1 至 32 条资源映射")
	}
	if s.Source != "script" && (!resourceText(s.OriginalName, 4096) || len(s.CatalogDigest) != 64) {
		return bad("invalid-resource-rule", "MCP 资源规则必须固定原始能力名及目录摘要")
	}
	for _, mapping := range in.Mappings {
		if (mapping.Literal == nil) == (mapping.Pointer == nil) || !resourceText(mapping.Kind, 64) || !resourceText(mapping.Authority, 256) || mapping.Kind == "global" || (mapping.Access != "read" && mapping.Access != "write") {
			return bad("invalid-resource-rule", "资源映射必须指定资源类型、真实来源、读写模式及唯一值来源")
		}
		if mapping.Pointer != nil {
			if !validResourcePointer(*mapping.Pointer) {
				return bad("invalid-resource-rule", "资源映射 JSON Pointer 无效")
			}
		} else if _, ok := normalizeResourceClaim(ResourceClaim{Kind: mapping.Kind, Authority: mapping.Authority, Key: *mapping.Literal, Access: mapping.Access, Subtree: mapping.Subtree}); !ok {
			return bad("invalid-resource-rule", "资源映射的固定资源身份无效")
		}
	}
	return nil
}

func validResourcePointer(pointer string) bool {
	if len(pointer) > 4096 || (pointer != "" && !strings.HasPrefix(pointer, "/")) {
		return false
	}
	for i := 0; i < len(pointer); i++ {
		if pointer[i] == '~' {
			i++
			if i == len(pointer) || (pointer[i] != '0' && pointer[i] != '1') {
				return false
			}
		}
	}
	return utf8.ValidString(pointer)
}

func resourcePointer(value any, pointer string) (any, bool) {
	if !validResourcePointer(pointer) {
		return nil, false
	}
	if pointer == "" {
		return value, true
	}
	for _, part := range strings.Split(pointer[1:], "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch item := value.(type) {
		case map[string]any:
			var exists bool
			value, exists = item[part]
			if !exists {
				return nil, false
			}
		case []any:
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 || n >= len(item) || strconv.Itoa(n) != part {
				return nil, false
			}
			value = item[n]
		default:
			return nil, false
		}
	}
	return value, true
}

func normalizeResourceClaim(c ResourceClaim) (ResourceClaim, bool) {
	if c.Kind == "global" {
		return ResourceClaim{Kind: "global", Authority: "*", Key: "*", Access: "write"}, true
	}
	if !resourceText(c.Kind, 64) || !resourceText(c.Authority, 256) || !resourceText(c.Key, 4096) || (c.Access != "read" && c.Access != "write") {
		return c, false
	}
	if c.Kind == "filesystem" || c.Subtree {
		if !strings.HasPrefix(c.Key, "/") || path.Clean(c.Key) != c.Key {
			return c, false
		}
	}
	return c, true
}

func canonicalResourceClaims(claims []ResourceClaim) []ResourceClaim {
	byKey := map[string]ResourceClaim{}
	for _, claim := range claims {
		c, valid := normalizeResourceClaim(claim)
		if !valid || c.Kind == "global" {
			return []ResourceClaim{{Kind: "global", Authority: "*", Key: "*", Access: "write"}}
		}
		key := c.Kind + "\x00" + c.Authority + "\x00" + c.Key
		if old, exists := byKey[key]; exists {
			c.Subtree = c.Subtree || old.Subtree
			if old.Access == "write" {
				c.Access = "write"
			}
		}
		byKey[key] = c
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]ResourceClaim, 0, len(keys))
	for _, key := range keys {
		out = append(out, byKey[key])
	}
	return out
}

func resourceRuleMatches(rule ResourceRule, c Capability) bool {
	s := rule.Selector
	return rule.Enabled && s.Source == c.Source && s.Ref.ID == c.Ref.ID && s.Ref.Revision == c.Ref.Revision && (s.Ref.Digest == "" || s.Ref.Digest == c.Ref.Digest) && s.OriginalName == c.OriginalName && s.CatalogDigest == c.CatalogDigest
}

func operationResourceClaims(snapshot CapabilitySnapshot, o Operation) ([]ResourceClaim, []RevisionRef) {
	claims := []ResourceClaim{}
	// Operation omits an empty rules slice in its persisted JSON. Keep the
	// derived zero-rule representation nil so a resumed approval has the
	// same immutable digest as the original proposal.
	var refs []RevisionRef
	complete := false
	args, err := jsonvalue.Decode(json.RawMessage(o.ArgumentsJSON))
	if err != nil {
		return canonicalResourceClaims([]ResourceClaim{{Kind: "global"}}), refs
	}
	for _, rule := range snapshot.ResourceRules {
		if !resourceRuleMatches(rule, o.Capability) {
			continue
		}
		refs = append(refs, RevisionRef{ID: rule.ID, Revision: rule.Revision, Digest: rule.Digest})
		complete = complete || rule.Complete
		for _, mapping := range rule.Mappings {
			key := ""
			if mapping.Literal != nil {
				key = *mapping.Literal
			} else if mapping.Pointer != nil {
				value, ok := resourcePointer(args, *mapping.Pointer)
				if !ok {
					return canonicalResourceClaims([]ResourceClaim{{Kind: "global"}}), refs
				}
				switch scalar := value.(type) {
				case string:
					key = scalar
				case json.Number:
					// 数字身份只允许规范整数，避免同一数值的多个写法绕开冲突。
					key = string(scalar)
					if strings.ContainsAny(key, ".eE+") || key == "-0" {
						return canonicalResourceClaims([]ResourceClaim{{Kind: "global"}}), refs
					}
				default:
					return canonicalResourceClaims([]ResourceClaim{{Kind: "global"}}), refs
				}
			}
			claims = append(claims, ResourceClaim{Kind: mapping.Kind, Authority: mapping.Authority, Key: key, Access: mapping.Access, Subtree: mapping.Subtree})
		}
	}
	switch o.Capability.Source {
	case "builtin":
		claims = append(claims, ResourceClaim{Kind: "docker", Authority: "local", Key: "/", Access: "read", Subtree: true})
		complete = true
	case "skill-load", "wiki":
		complete = true
	case "script":
		claims = append(claims, ResourceClaim{Kind: "workspace", Authority: "local", Key: o.TaskID, Access: "write"})
		if o.Execution != nil && (o.Execution.Grant == nil || len(o.Execution.Grant.Network) == 0) {
			complete = true
		}
	}
	if o.Execution != nil {
		// stdio 的启动和后台代码拥有整个 grant，不能用工具参数缩小这个范围。
		if o.Capability.Source != "script" {
			complete = o.Execution.Grant == nil || len(o.Execution.Grant.Network) == 0
			claims = append(claims, ResourceClaim{Kind: "runtime", Authority: "local", Key: o.ID, Access: "write"})
		}
		if grant := o.Execution.Grant; grant != nil {
			for _, directory := range grant.Directories {
				access := "read"
				if directory.Access == "rw" {
					access = "write"
				}
				claims = append(claims, ResourceClaim{Kind: "filesystem", Authority: "local", Key: directory.Path, Access: access, Subtree: true})
			}
		}
	}
	if !complete {
		claims = append(claims, ResourceClaim{Kind: "global"})
	}
	return canonicalResourceClaims(claims), refs
}

func readResourceRule(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string, revision int) (ResourceRule, error) {
	var rule ResourceRule
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM resource_rules WHERE id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", id, revision, revision).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return rule, bad("resource-rule-not-found", "资源规则不存在")
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &rule)
	}
	return rule, err
}

func (m *Manager) ResourceRules(ctx context.Context) ([]ResourceRule, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	rules, err := readDocuments[ResourceRule](ctx, m.store.db, "SELECT r.document FROM resource_rules r JOIN (SELECT id,MAX(revision) AS revision FROM resource_rules GROUP BY id) latest ON r.id=latest.id AND r.revision=latest.revision ORDER BY r.id")
	return rules, storageFailure(err)
}

func (m *Manager) GetResourceRule(ctx context.Context, id string, revision int) (ResourceRule, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ResourceRule{}, closedError()
	}
	rule, err := readResourceRule(ctx, m.store.db, id, revision)
	return rule, storageFailure(err)
}

func (m *Manager) PutResourceRule(ctx context.Context, id string, expected int, in ResourceRuleInput) (ResourceRule, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var rule ResourceRule
	if m.closed {
		return rule, closedError()
	}
	if err := validateResourceRule(in); err != nil {
		return rule, err
	}
	if id == "" {
		if expected != 0 {
			return rule, bad("invalid-resource-rule", "创建资源规则的预期修订必须为零")
		}
		id = m.deps.NewID()
	} else if !requestPattern.MatchString(id) || expected < 1 {
		return rule, bad("invalid-resource-rule", "更新资源规则必须指定编号及当前修订")
	}
	err := m.store.write(ctx, "resource-rule", func(tx *sql.Tx) error {
		var latest int
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM resource_rules WHERE id=?", id).Scan(&latest); err != nil {
			return err
		}
		if latest != expected {
			return &Error{409, "revision-conflict", "资源规则修订已变化"}
		}
		rule = ResourceRule{ResourceRuleInput: in, ID: id, Revision: latest + 1, CreatedAt: stamp(m.deps.Now())}
		rule.Digest = digestJSON(rule)
		raw, err := json.Marshal(rule)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO resource_rules(id,revision,document) VALUES(?,?,?)", id, rule.Revision, string(raw))
		return err
	})
	return rule, storageFailure(err)
}
