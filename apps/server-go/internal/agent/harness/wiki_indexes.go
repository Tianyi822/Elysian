package harness

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"time"
)

// WikiIndexInput 与 WikiIndexStatus 保留为共享契约类型：索引重建入口已随整理管线
// 退役，但 packages/foundation/contracts 的固定 fixture 仍按这两个形状往返。
type WikiIndexInput struct {
	RequestID       string `json:"requestId"`
	ProfileID       string `json:"profileId"`
	ProfileRevision int    `json:"profileRevision"`
}

type WikiIndexStatus struct {
	Profile      EmbeddingProfile `json:"profile"`
	Pages        int              `json:"pages"`
	IndexedPages int              `json:"indexedPages"`
	Status       string           `json:"status"`
}

func cosine(a, b []float64) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	dot, aa, bb := 0.0, 0.0, 0.0
	for i := range a {
		dot += a[i] * b[i]
		aa += a[i] * a[i]
		bb += b[i] * b[i]
	}
	if aa == 0 || bb == 0 {
		return 0
	}
	value := dot / (math.Sqrt(aa) * math.Sqrt(bb))
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

// 错误、空索引及改版后的旧索引不影响全文检索。向量只匹配当前不可变修订。
func (m *Manager) wikiHybridSearchLocked(ctx context.Context, pages []WikiPage, query string, text WikiSearchResult, limit int) WikiSearchResult {
	text.Degraded = true
	if text.Reason == "" {
		text.Reason = "使用 SQLite 中文双字全文回落"
	}
	profiles, err := m.readEmbeddingProfiles()
	if err != nil {
		text.Reason = "Embedding 配置不可用，使用 SQLite 中文双字全文回落"
		return text
	}
	latest := map[string]EmbeddingProfile{}
	for _, p := range profiles {
		latest[p.ID] = p
	}
	var profile EmbeddingProfile
	ids := []string{}
	for id := range latest {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if latest[id].Active {
			profile = latest[id]
			break
		}
	}
	if profile.ID == "" {
		return text
	}
	byID := map[string]WikiPage{}
	for _, p := range pages {
		if p.Status == "active" {
			byID[p.ID] = p
		}
	}
	rows, err := m.store.db.QueryContext(ctx, "SELECT page_id,page_revision,digest,vector FROM wiki_embedding_indexes WHERE profile_id=? AND profile_revision=?", profile.ID, profile.Revision)
	if err != nil {
		return text
	}
	type item struct {
		page   WikiPage
		vector []float64
		score  float64
	}
	items := []item{}
	for rows.Next() {
		var id, digest, raw string
		var revision int
		if rows.Scan(&id, &revision, &digest, &raw) != nil {
			continue
		}
		page, ok := byID[id]
		if !ok || page.Revision != revision || page.Digest != digest {
			continue
		}
		if page.ExpiresAt != "" {
			if at, e := time.Parse(time.RFC3339Nano, page.ExpiresAt); e == nil && !m.deps.Now().Before(at) {
				continue
			}
		}
		var vector []float64
		if json.Unmarshal([]byte(raw), &vector) != nil || len(vector) != profile.Dimensions {
			continue
		}
		items = append(items, item{page: page, vector: vector})
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(items) == 0 {
		text.Reason = "Embedding 索引尚未就绪，使用 SQLite 中文双字全文回落"
		return text
	}
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	// 页面、向量与配置已复制为固定快照；等待供应商期间释放运行锁，
	// 让取消与来源撤回及时落盘。返回后重新核对来源，不能发布被撤回的页。
	m.mu.Unlock()
	vector, err := func() ([]float64, error) {
		defer m.mu.Lock()
		return m.embeddingComplete(queryCtx, profile, query, EmbeddingRequest{Purpose: "query"})
	}()
	if m.closed {
		return WikiSearchResult{Items: []WikiSearchHit{}, Degraded: true, Reason: "运行内核已停止"}
	}
	validItems := items[:0]
	for _, item := range items {
		refs := mergeWikiRefs(item.page.Sources, []WikiRef{{PageID: item.page.ID, Revision: item.page.Revision, Digest: item.page.Digest}})
		if validateWikiSources(ctx, m.store.db, refs) == nil {
			validItems = append(validItems, item)
		}
	}
	items = validItems
	validText := []WikiSearchHit{}
	for _, hit := range text.Items {
		refs := mergeWikiRefs(hit.Page.Sources, []WikiRef{{PageID: hit.Page.ID, Revision: hit.Page.Revision, Digest: hit.Page.Digest}})
		if validateWikiSources(ctx, m.store.db, refs) == nil {
			validText = append(validText, hit)
		}
	}
	text.Items = validText
	if err != nil {
		text.Reason = "Embedding 查询失败，使用 SQLite 中文双字全文回落"
		return text
	}
	for i := range items {
		items[i].score = cosine(vector, items[i].vector)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].score != items[j].score {
			return items[i].score > items[j].score
		}
		return items[i].page.ID < items[j].page.ID
	})
	fused := map[string]WikiSearchHit{}
	for i, hit := range text.Items {
		hit.Score = 1 / float64(61+i)
		hit.Method = "hybrid-rrf"
		fused[hit.Page.ID] = hit
	}
	for i, value := range items {
		if value.score <= 0 {
			continue
		}
		hit := fused[value.page.ID]
		hit.Page, hit.Method = value.page, "hybrid-rrf"
		hit.Score += 1 / float64(61+i)
		fused[value.page.ID] = hit
	}
	result := WikiSearchResult{Items: []WikiSearchHit{}}
	for _, hit := range fused {
		result.Items = append(result.Items, hit)
	}
	sort.Slice(result.Items, func(i, j int) bool {
		if result.Items[i].Score != result.Items[j].Score {
			return result.Items[i].Score > result.Items[j].Score
		}
		return result.Items[i].Page.ID < result.Items[j].Page.ID
	})
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
	}
	if len(items) < len(byID) {
		result.Degraded, result.Reason = true, "部分页面索引未就绪，已合并 SQLite 中文双字全文结果"
	}
	return result
}
