package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"elysian/server/internal/agent/harness/workspace"
)

func WikiRefKey(r WikiRef) string { return r.PageID + ":" + strconv.Itoa(r.Revision) }

func MergeWikiRefs(groups ...[]WikiRef) []WikiRef {
	byKey := map[string]WikiRef{}
	for _, refs := range groups {
		for _, ref := range refs {
			byKey[WikiRefKey(ref)] = ref
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]WikiRef, 0, len(keys))
	for _, key := range keys {
		out = append(out, byKey[key])
	}
	return out
}

// unicode61 对连续中文不分词，因此由父端先生成汉字双字片段及标识符词项。
// 写入和查询共用分词器；MATCH 参数只由加引号的词项组成，不接受查询表达式。
func WikiFTSText(p WikiPage) string {
	terms := []string{}
	for term := range WikiTokens(WikiSearchText(p)) {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	return strings.Join(terms, " ")
}

func WikiDigest(title, markdown string) string {
	h := sha256.Sum256([]byte(title + "\x00" + markdown))
	return hex.EncodeToString(h[:])
}

func DecodeWiki(raw string, p *WikiPage) error {
	if err := json.Unmarshal([]byte(raw), p); err != nil {
		return err
	}
	if p.Evidence == nil {
		p.Evidence = []WikiEvidence{}
	}
	if p.Sources == nil {
		p.Sources = []WikiRef{}
	}
	if p.Links == nil {
		p.Links = []string{}
	}
	return nil
}

func WikiTokens(s string) map[string]int {
	out := map[string]int{}
	var word, han []rune
	flushWord := func() {
		if len(word) != 0 {
			out[string(word)]++
			word = nil
		}
	}
	flushHan := func() {
		if len(han) == 1 {
			out[string(han)]++
		}
		for i := 0; i+1 < len(han); i++ {
			out[string(han[i:i+2])]++
		}
		han = nil
	}
	for _, r := range strings.ToLower(s) {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			han = append(han, r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			flushHan()
			word = append(word, r)
		default:
			flushWord()
			flushHan()
		}
	}
	flushWord()
	flushHan()
	return out
}

func WikiSearchText(p WikiPage) string {
	return p.Title + "\n" + p.Slug + "\n" + strings.Join(p.Tags, " ") + "\n" + strings.Join(p.Aliases, " ") + "\n" + p.Markdown
}

func WorkspaceWikiKey(version workspace.Version) string {
	return version.TaskID + ":" + strconv.Itoa(version.Revision)
}
