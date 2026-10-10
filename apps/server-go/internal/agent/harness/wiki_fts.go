package harness

import (
	"context"
	"sort"
	"strings"
)

// unicode61 对连续中文不分词，因此由父端先生成汉字双字片段及标识符词项。
// 写入和查询共用分词器；MATCH 参数只由加引号的词项组成，不接受查询表达式。
func wikiFTSText(p WikiPage) string {
	terms := []string{}
	for term := range wikiTokens(wikiSearchText(p)) {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	return strings.Join(terms, " ")
}

func (m *Manager) wikiTextMatchesLocked(ctx context.Context, spaceID, query string) (map[string]bool, error) {
	terms := []string{}
	for term := range wikiTokens(query) {
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
	rows, err := m.store.db.QueryContext(ctx, `SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ? AND (?='' OR space_id=?)`, strings.Join(terms, " OR "), spaceID, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
