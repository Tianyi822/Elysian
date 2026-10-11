package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"time"
)

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

func (m *Manager) ListWikiIndexes(ctx context.Context, spaceID string) ([]WikiIndexStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.ensureWikiSpaceLocked(ctx, spaceID); err != nil {
		return nil, err
	}
	profiles, err := m.listEmbeddingProfiles(ctx)
	if err != nil {
		return nil, err
	}
	result := []WikiIndexStatus{}
	for _, profile := range profiles {
		item := WikiIndexStatus{Profile: profile}
		if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_pages WHERE space_id=? AND status='active'", spaceID).Scan(&item.Pages); err != nil {
			return nil, err
		}
		if err = m.store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM wiki_pages p JOIN wiki_embedding_indexes i ON i.page_id=p.id AND i.page_revision=p.current_revision WHERE p.space_id=? AND p.status='active' AND i.profile_id=? AND i.profile_revision=?`, spaceID, profile.ID, profile.Revision).Scan(&item.IndexedPages); err != nil {
			return nil, err
		}
		item.Status = "ready"
		if item.IndexedPages < item.Pages {
			item.Status = "stale"
		}
		result = append(result, item)
	}
	return result, nil
}

func (m *Manager) RebuildWikiIndex(ctx context.Context, spaceID string, input WikiIndexInput) (WikiJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return WikiJob{}, err
	}
	if !requestPattern.MatchString(input.RequestID) {
		return WikiJob{}, bad("invalid-request-id", "索引重建请求标识无效")
	}
	if _, err := m.ensureWikiSpaceLocked(ctx, spaceID); err != nil {
		return WikiJob{}, err
	}
	var prior string
	err := m.store.db.QueryRowContext(ctx, "SELECT id FROM wiki_jobs WHERE kind='embedding' AND origin_kind='space' AND origin_id=?", input.RequestID).Scan(&prior)
	if err == nil {
		job, e := readWikiJob(ctx, m.store.db, prior)
		if e == nil && (job.SpaceID != spaceID || job.EmbeddingProfile == nil || job.EmbeddingProfile.ID != input.ProfileID || job.EmbeddingProfile.Revision != input.ProfileRevision) {
			return WikiJob{}, &Error{409, "request-conflict", "索引重建请求标识已用于其他参数"}
		}
		return job, e
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return WikiJob{}, err
	}
	profiles, err := m.readEmbeddingProfiles()
	if err != nil {
		return WikiJob{}, err
	}
	var fixed, latest EmbeddingProfile
	for _, p := range profiles {
		if p.ID == input.ProfileID {
			latest = p
			if p.Revision == input.ProfileRevision {
				fixed = p
			}
		}
	}
	if fixed.ID == "" || !fixed.Active || !latest.Active {
		return WikiJob{}, bad("embedding-profile-unavailable", "Embedding 配置不存在、已停用或修订不可用")
	}
	pages, err := m.listWikiPagesLocked(ctx, spaceID, false)
	if err != nil {
		return WikiJob{}, err
	}
	refs := []WikiRef{}
	for _, page := range pages {
		refs = append(refs, WikiRef{PageID: page.ID, Revision: page.Revision, Digest: page.Digest})
	}
	raw, _ := json.Marshal(refs)
	public := fixed.Public()
	job := WikiJob{ID: m.deps.NewID(), Kind: "embedding", OriginKind: "space", OriginID: input.RequestID, SpaceID: spaceID, Status: StateQueued, CreatedAt: wikiNow(m), Input: string(raw), EmbeddingProfile: &public, CandidateIDs: []string{}, Sources: []WikiRef{}}
	err = m.store.write(ctx, "wiki-index-enqueue", func(tx *sql.Tx) error { return saveWikiJob(ctx, tx, job) })
	return job, err
}

func (m *Manager) runNextWikiIndexJob() bool {
	m.mu.Lock()
	if m.closed || m.blocked != "" || m.storageError || m.store.recordsFault() != nil || m.ctx.Err() != nil || m.deps.DispatchGuard != nil && m.deps.DispatchGuard() != nil {
		m.mu.Unlock()
		return false
	}
	if !m.wikiBackgroundReadyLocked() {
		m.mu.Unlock()
		return false
	}
	var id string
	err := m.store.db.QueryRowContext(m.ctx, "SELECT id FROM wiki_jobs WHERE kind='embedding' AND state='queued' ORDER BY rowid LIMIT 1").Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		m.mu.Unlock()
		return false
	}
	if err != nil {
		m.storageFailedLocked()
		m.mu.Unlock()
		return false
	}
	job, err := readWikiJob(m.ctx, m.store.db, id)
	if err != nil {
		m.storageFailedLocked()
		m.mu.Unlock()
		return false
	}
	job.Status, job.StartedAt = StateRunning, wikiNow(m)
	if err = m.store.write(m.ctx, "wiki-index-start", func(tx *sql.Tx) error { return saveWikiJob(m.ctx, tx, job) }); err != nil {
		m.storageFailedLocked()
		m.mu.Unlock()
		return false
	}
	profiles, err := m.readEmbeddingProfiles()
	var profile EmbeddingProfile
	if err == nil && job.EmbeddingProfile != nil {
		for _, p := range profiles {
			if p.ID == job.EmbeddingProfile.ID && p.Revision == job.EmbeddingProfile.Revision {
				profile = p
				break
			}
		}
	}
	if err == nil && profile.ID == "" {
		err = bad("embedding-profile-unavailable", "索引固定的 Embedding 修订不可用")
	}
	var refs []WikiRef
	if err == nil {
		err = json.Unmarshal([]byte(job.Input), &refs)
	}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(m.ctx, 60*time.Second)
	defer cancel()
	for _, ref := range refs {
		if err != nil {
			break
		}
		m.mu.Lock()
		var raw string
		err = validateWikiSources(ctx, m.store.db, []WikiRef{ref})
		if err == nil {
			err = m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_page_revisions WHERE page_id=? AND revision=?", ref.PageID, ref.Revision).Scan(&raw)
		}
		m.mu.Unlock()
		if err != nil {
			break
		}
		var page WikiPage
		if err = decodeWiki(raw, &page); err != nil {
			break
		}
		var vector []float64
		vector, err = m.embeddingComplete(ctx, profile, page.Title+"\n"+page.Markdown, EmbeddingRequest{Purpose: "index", JobID: job.ID, Page: &ref})
		if err != nil {
			break
		}
		data, _ := json.Marshal(vector)
		m.mu.Lock()
		err = m.store.write(ctx, "wiki-index-page", func(tx *sql.Tx) error {
			if e := validateWikiSources(ctx, tx, []WikiRef{ref}); e != nil {
				return e
			}
			_, e := tx.ExecContext(ctx, `INSERT INTO wiki_embedding_indexes(page_id,page_revision,digest,profile_id,profile_revision,vector,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(page_id,page_revision,profile_id,profile_revision) DO UPDATE SET digest=excluded.digest,vector=excluded.vector,created_at=excluded.created_at`, ref.PageID, ref.Revision, ref.Digest, profile.ID, profile.Revision, string(data), wikiNow(m))
			return e
		})
		m.mu.Unlock()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	job.Status, job.EndedAt = StateSucceeded, wikiNow(m)
	if err != nil {
		job.Status = StateFailed
		job.Error = &Failure{Code: "embedding-index-failed", Message: "Embedding 索引重建未完成，搜索继续使用文本回落"}
	}
	if m.ctx.Err() != nil {
		job.Status = StateInterrupted
		job.Error = &Failure{Code: "panel-stopped", Message: "面板停止中断了 Embedding 索引重建"}
	}
	if e := m.store.write(context.Background(), "wiki-index-finish", func(tx *sql.Tx) error { return saveWikiJob(context.Background(), tx, job) }); e != nil {
		m.storageFailedLocked()
		return false
	}
	return m.ctx.Err() == nil
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
