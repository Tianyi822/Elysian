package harness

import (
	"context"
	"sort"
	"strings"

	"elysian/server/internal/agent/harness/state"
)

func (m *Manager) wikiTextMatchesLocked(ctx context.Context, spaceID, query string) (map[string]bool, error) {
	terms := []string{}
	for term := range state.WikiTokens(query) {
		terms = append(terms, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
	}
	if len(terms) > 512 {
		return nil, bad("wiki-query-limit", "Wiki 搜索最多包含 512 个词项")
	}
	out := map[string]bool{}
	if len(terms) == 0 {
		return out, nil
	}
	sort.Strings(terms)
	rows, err := readView(ctx, m.store).WikiTextMatches(ctx, strings.Join(terms, " OR "), spaceID)
	if err != nil {
		return nil, err
	}

	for _, record := range rows {
		var id string
		id = record.PageID
		out[id] = true
	}
	return out, nil
}
