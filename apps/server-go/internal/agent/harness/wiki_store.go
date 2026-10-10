package harness

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var wikiSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,127}$`)
var wikiLinkPattern = regexp.MustCompile(`\[\[([^\]]+)\]\]`)

func wikiDigest(title, markdown string) string {
	h := sha256.Sum256([]byte(title + "\x00" + markdown))
	return hex.EncodeToString(h[:])
}
func wikiNow(m *Manager) string { return stamp(m.deps.Now()) }
func wikiValidText(s string, n int) bool {
	return strings.TrimSpace(s) != "" && len(s) <= n && utf8.ValidString(s) && !strings.ContainsRune(s, '\x00')
}
func validateWikiInput(in WikiPageInput) error {
	if !wikiSlugPattern.MatchString(in.Slug) || strings.Contains(in.Slug, "..") || strings.Contains(in.Slug, "//") || !wikiValidText(in.Title, 512) || len(in.Markdown) > wikiPageBytes || !utf8.ValidString(in.Markdown) || strings.ContainsRune(in.Markdown, '\x00') {
		return bad("invalid-wiki-page", "Wiki 页面 slug、标题或正文无效")
	}
	kind := in.Kind
	if kind == "" {
		kind = "reference"
	}
	switch kind {
	case "reference", "preference", "convention", "experience", "decision", "runbook", "observation", "index", "changelog", "sources":
	default:
		return bad("invalid-wiki-page", "Wiki 页面类型无效")
	}
	if len(in.Evidence) > 32 || len(in.Sources) > 64 {
		return bad("wiki-evidence-limit", "Wiki 证据或来源数量超过限额")
	}
	for _, e := range in.Evidence {
		if !wikiValidText(e.Text, 2048) || len(e.URI) > 2048 || len(e.ID) > 128 || len(e.Kind) > 64 {
			return bad("wiki-evidence-invalid", "Wiki 证据摘录无效或超过限额")
		}
	}
	for _, values := range [][]string{in.Tags, in.Aliases} {
		if len(values) > 32 {
			return bad("wiki-search-label-limit", "Wiki 标签和别名各最多 32 项")
		}
		for _, value := range values {
			if !wikiValidText(value, 128) {
				return bad("wiki-search-label-invalid", "Wiki 标签或别名无效")
			}
		}
	}
	if in.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, in.ExpiresAt); err != nil {
			return bad("wiki-expiry-invalid", "Wiki 有效期必须为 RFC3339 时间")
		}
	}
	return nil
}
func normalizeWikiInput(in WikiPageInput) WikiPageInput {
	if in.Kind == "" {
		in.Kind = "reference"
	}
	return in
}
func marshalWiki(v any) (string, error) { b, e := json.Marshal(v); return string(b), e }
func decodeWiki(raw string, p *WikiPage) error {
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

func (m *Manager) ensureWikiSpaceLocked(ctx context.Context, id string) (WikiSpace, error) {
	var raw string
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_spaces WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return WikiSpace{}, &Error{404, "wiki-space-not-found", "Wiki 空间不存在"}
	}
	if err != nil {
		return WikiSpace{}, err
	}
	var s WikiSpace
	err = json.Unmarshal([]byte(raw), &s)
	return s, err
}
func (m *Manager) listWikiSpacesLocked(ctx context.Context) ([]WikiSpace, error) {
	rows, err := m.store.db.QueryContext(ctx, "SELECT document FROM wiki_spaces ORDER BY kind DESC,name,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WikiSpace{}
	for rows.Next() {
		var raw string
		var s WikiSpace
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
func (m *Manager) CreateWikiSpace(ctx context.Context, name, kind string) (WikiSpace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return WikiSpace{}, err
	}
	if !wikiValidText(name, 120) {
		return WikiSpace{}, bad("invalid-wiki-space", "Wiki 空间名称无效")
	}
	if kind != "business" && kind != "global" {
		return WikiSpace{}, bad("invalid-wiki-space", "Wiki 空间类型无效")
	}
	s := WikiSpace{ID: m.deps.NewID(), Revision: 1, Name: strings.TrimSpace(name), Kind: kind, CreatedAt: wikiNow(m)}
	raw, _ := marshalWiki(s)
	err := m.store.write(ctx, "wiki-space-create", func(tx *sql.Tx) error {
		if kind == "global" {
			var n int
			if e := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_spaces WHERE kind='global'").Scan(&n); e != nil {
				return e
			}
			if n > 0 {
				return &Error{409, "wiki-global-exists", "全局 Wiki 空间已存在"}
			}
		}
		if _, e := tx.ExecContext(ctx, "INSERT INTO wiki_spaces(id,name,kind,document) VALUES(?,?,?,?)", s.ID, s.Name, s.Kind, raw); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "INSERT INTO wiki_space_revisions(id,revision,document) VALUES(?,?,?)", s.ID, s.Revision, raw)
		return e
	})
	return s, err
}
func (m *Manager) ListWikiSpaces(ctx context.Context) ([]WikiSpace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listWikiSpacesLocked(ctx)
}

func (m *Manager) SetWikiSessionSpace(ctx context.Context, sessionID, spaceID string, includeGlobal bool) (WikiSpace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return WikiSpace{}, err
	}
	session, err := readSession(ctx, m.store.db, sessionID)
	if err != nil {
		return WikiSpace{}, err
	}
	if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		return WikiSpace{}, &Error{409, "session-busy", "会话忙碌时不能修改记忆空间"}
	}
	var s WikiSpace
	if spaceID != "" {
		s, err = m.ensureWikiSpaceLocked(ctx, spaceID)
	}
	if err != nil {
		return s, err
	}
	if includeGlobal && s.Kind == "global" {
		includeGlobal = true
	}
	doc := struct {
		SpaceID       string `json:"spaceId"`
		IncludeGlobal bool   `json:"includeGlobal"`
	}{spaceID, includeGlobal}
	raw, _ := marshalWiki(doc)
	err = m.store.write(ctx, "wiki-session-space", func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, "INSERT INTO wiki_session_spaces(session_id,document) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET document=excluded.document", sessionID, raw); e != nil {
			return e
		}
		session.LastActivityAt = wikiNow(m)
		return saveSession(ctx, tx, session)
	})
	return s, err
}
func (m *Manager) wikiSessionSpacesLocked(ctx context.Context, sessionID string) ([]string, error) {
	var raw string
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", sessionID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var d struct {
		SpaceID       string `json:"spaceId"`
		IncludeGlobal bool   `json:"includeGlobal"`
	}
	if json.Unmarshal([]byte(raw), &d) != nil {
		return nil, errors.New("Wiki 空间选择记录无效")
	}
	ids := []string{}
	if d.SpaceID != "" {
		ids = append(ids, d.SpaceID)
	}
	if d.IncludeGlobal {
		var g string
		if e := m.store.db.QueryRowContext(ctx, "SELECT id FROM wiki_spaces WHERE kind='global'").Scan(&g); e == nil {
			ids = append(ids, g)
		}
	}
	return ids, nil
}

func (m *Manager) createWikiPageLocked(ctx context.Context, spaceID string, in WikiPageInput, origin string) (WikiPage, error) {
	if err := m.workflowWritable(); err != nil {
		return WikiPage{}, err
	}
	in = normalizeWikiInput(in)
	if err := validateWikiInput(in); err != nil {
		return WikiPage{}, err
	}
	if _, err := m.ensureWikiSpaceLocked(ctx, spaceID); err != nil {
		return WikiPage{}, err
	}
	now := wikiNow(m)
	if in.Kind == "observation" && in.ExpiresAt == "" {
		in.ExpiresAt = stamp(m.deps.Now().Add(30 * 24 * time.Hour))
	}
	p := WikiPage{ID: m.deps.NewID(), SpaceID: spaceID, Slug: in.Slug, Revision: 1, Title: in.Title, Markdown: in.Markdown, Kind: in.Kind, Status: "active", Digest: wikiDigest(in.Title, in.Markdown), CreatedAt: now, UpdatedAt: now, ExpiresAt: in.ExpiresAt, Evidence: in.Evidence, Sources: in.Sources, Links: wikiLinks(in.Markdown)}
	p.Tags, p.Aliases = in.Tags, in.Aliases
	if p.Evidence == nil {
		p.Evidence = []WikiEvidence{}
	}
	if p.Sources == nil {
		p.Sources = []WikiRef{}
	}
	if p.Links == nil {
		p.Links = []string{}
	}
	err := m.store.write(ctx, "wiki-page-create", func(tx *sql.Tx) error {
		return publishWikiPage(ctx, tx, &p, 0)
	})
	return p, err
}
func wikiLinks(md string) []string {
	matches := wikiLinkPattern.FindAllStringSubmatch(md, -1)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range matches {
		v := strings.TrimSpace(m[1])
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
func (m *Manager) CreateWikiPage(ctx context.Context, spaceID string, in WikiPageInput) (WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.createWikiPageLocked(ctx, spaceID, in, "manual")
}
func (m *Manager) getWikiPageLocked(ctx context.Context, id string) (WikiPage, error) {
	var raw string
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return WikiPage{}, &Error{404, "wiki-page-not-found", "Wiki 页面不存在"}
	}
	if err != nil {
		return WikiPage{}, err
	}
	var p WikiPage
	if err := decodeWiki(raw, &p); err != nil {
		return p, err
	}
	err = m.markWikiEvidence(ctx, &p)
	return p, err
}
func (m *Manager) GetWikiPage(ctx context.Context, id string) (WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.getWikiPageLocked(ctx, id)
}
func (m *Manager) listWikiPagesLocked(ctx context.Context, spaceID string, includeWithdrawn bool) ([]WikiPage, error) {
	q := `SELECT document FROM wiki_pages WHERE (?='' OR space_id=?)`
	args := []any{spaceID, spaceID}
	if !includeWithdrawn {
		q += ` AND status<>'withdrawn'`
	}
	q += ` ORDER BY updated_at` // updated_at lives in JSON; deterministic rowid is preferable
	q = `SELECT document FROM wiki_pages WHERE (?='' OR space_id=?)`
	if !includeWithdrawn {
		q += ` AND status<>'withdrawn'`
	}
	q += ` ORDER BY rowid DESC`
	rows, err := m.store.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WikiPage{}
	for rows.Next() {
		var raw string
		var p WikiPage
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = decodeWiki(raw, &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	for i := range out {
		if err = m.markWikiEvidence(ctx, &out[i]); err != nil {
			return out, err
		}
	}
	return out, nil
}
func (m *Manager) ListWikiPages(ctx context.Context, spaceID string, includeWithdrawn bool) ([]WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.listWikiPagesLocked(ctx, spaceID, includeWithdrawn)
}
func (m *Manager) updateWikiPageLocked(ctx context.Context, id string, in WikiPageInput, status string) (WikiPage, error) {
	if err := m.workflowWritable(); err != nil {
		return WikiPage{}, err
	}
	in = normalizeWikiInput(in)
	old, err := m.getWikiPageLocked(ctx, id)
	if err != nil {
		return old, err
	}
	if in.ExpectedRevision != old.Revision {
		return old, &Error{409, "revision-conflict", "Wiki 页面版本已变化，请重新读取"}
	}
	if err = validateWikiInput(in); err != nil {
		return old, err
	}
	p := old
	p.Revision++
	p.Title = in.Title
	p.Markdown = in.Markdown
	p.Kind = in.Kind
	p.Status = status
	p.Digest = wikiDigest(p.Title, p.Markdown)
	p.UpdatedAt = wikiNow(m)
	p.ExpiresAt = in.ExpiresAt
	if p.Kind == "observation" && p.ExpiresAt == "" {
		p.ExpiresAt = stamp(m.deps.Now().Add(30 * 24 * time.Hour))
	}
	p.Evidence = in.Evidence
	p.Sources = in.Sources
	p.Tags, p.Aliases = in.Tags, in.Aliases
	p.Links = wikiLinks(in.Markdown)
	if status == "withdrawn" {
		p.WithdrawnAt = p.UpdatedAt
	} else {
		p.WithdrawnAt = ""
	}
	err = m.store.write(ctx, "wiki-page-revision", func(tx *sql.Tx) error {
		if e := publishWikiPage(ctx, tx, &p, old.Revision); e != nil {
			return e
		}
		if status == "withdrawn" {
			return m.withdrawWikiSourcesTx(ctx, tx, p.ID)
		}
		return nil
	})
	if err == nil && status == "withdrawn" {
		m.cancelInvalidWikiExecutionsLocked(ctx)
	}
	return p, err
}
func (m *Manager) UpdateWikiPage(ctx context.Context, id string, in WikiPageInput) (WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.updateWikiPageLocked(ctx, id, in, "active")
}
func (m *Manager) WithdrawWikiPage(ctx context.Context, id string, expected int) (WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.getWikiPageLocked(ctx, id)
	if err != nil {
		return p, err
	}
	in := WikiPageInput{ExpectedRevision: expected, Slug: p.Slug, Title: p.Title, Markdown: p.Markdown, Kind: p.Kind, ExpiresAt: p.ExpiresAt, Evidence: p.Evidence, Sources: p.Sources}
	in.Tags, in.Aliases = p.Tags, p.Aliases
	return m.updateWikiPageLocked(ctx, id, in, "withdrawn")
}

func wikiTokens(s string) map[string]int {
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
func wikiTextScore(q, p string) float64 {
	a, b := wikiTokens(q), wikiTokens(p)
	if len(a) == 0 {
		return 0
	}
	score := 0.0
	for k := range a {
		if b[k] > 0 {
			score++
		}
	}
	return score / float64(len(a))
}
func wikiSearchText(p WikiPage) string {
	return p.Title + "\n" + p.Slug + "\n" + strings.Join(p.Tags, " ") + "\n" + strings.Join(p.Aliases, " ") + "\n" + p.Markdown
}
func (m *Manager) wikiSearchLocked(ctx context.Context, spaceID, q string, limit int) (WikiSearchResult, error) {
	if limit < 1 || limit > 100 {
		limit = 8
	}
	pages, err := m.listWikiPagesLocked(ctx, spaceID, false)
	if err != nil {
		return WikiSearchResult{}, err
	}
	matches, err := m.wikiTextMatchesLocked(ctx, spaceID, q)
	if err != nil {
		return WikiSearchResult{}, err
	}
	now := m.deps.Now()
	out := WikiSearchResult{Items: []WikiSearchHit{}, Degraded: true, Reason: "使用 SQLite 中文双字全文回落"}
	visible := make([]WikiPage, 0, len(pages))
	for _, p := range pages {
		if p.Status != "active" {
			continue
		}
		if p.ExpiresAt != "" {
			if t, e := time.Parse(time.RFC3339Nano, p.ExpiresAt); e != nil || !now.Before(t) {
				continue
			}
		}
		if err := validateWikiSources(ctx, m.store.db, []WikiRef{{p.ID, p.Revision, p.Digest}}); err != nil {
			var invalid *Error
			if errors.As(err, &invalid) && invalid.Code == "wiki-source-withdrawn" {
				continue
			}
			return WikiSearchResult{}, err
		}
		visible = append(visible, p)
		if !matches[p.ID] {
			continue
		}
		score := wikiTextScore(q, wikiSearchText(p))
		if score > 0 {
			out.Items = append(out.Items, WikiSearchHit{Page: p, Score: score, Method: "sqlite-text"})
		}
	}
	sort.SliceStable(out.Items, func(i, j int) bool {
		if out.Items[i].Score != out.Items[j].Score {
			return out.Items[i].Score > out.Items[j].Score
		}
		return out.Items[i].Page.UpdatedAt > out.Items[j].Page.UpdatedAt
	})
	if len(out.Items) > limit {
		out.Items = out.Items[:limit]
	}
	for i := range out.Items {
		if len(out.Items[i].Page.Markdown) > wikiRecallBytes {
			out.Items[i].Page.Markdown = out.Items[i].Page.Markdown[:wikiRecallBytes]
		}
	}
	return m.wikiHybridSearchLocked(ctx, visible, q, out, limit), nil
}
func (m *Manager) SearchWiki(ctx context.Context, spaceID, q string, limit int) (WikiSearchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WikiSearchResult{}, closedError()
	}
	if strings.TrimSpace(q) == "" || len(q) > wikiExtractionBytes {
		return WikiSearchResult{}, bad("invalid-wiki-query", "Wiki 搜索内容不能为空或超过容量限制")
	}
	return m.wikiSearchLocked(ctx, spaceID, q, limit)
}

func (m *Manager) WikiCheck(ctx context.Context, spaceID string) (WikiCheck, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pages, err := m.listWikiPagesLocked(ctx, spaceID, true)
	if err != nil {
		return WikiCheck{}, err
	}
	slugs := map[string]bool{}
	linked := map[string]bool{}
	for _, p := range pages {
		if p.Status == "active" {
			slugs[p.ID] = true
		}
		for _, id := range p.Links {
			linked[id] = true
		}
	}
	out := WikiCheck{OrphanPages: []string{}, BrokenLinks: []string{}, ExpiredPages: []string{}, InvalidSources: []string{}}
	for _, p := range pages {
		if !linked[p.ID] && len(p.Links) == 0 {
			out.OrphanPages = append(out.OrphanPages, p.ID)
		}
		for _, l := range p.Links {
			if !slugs[l] {
				out.BrokenLinks = append(out.BrokenLinks, p.Slug+" -> "+l)
			}
		}
		if p.ExpiresAt != "" {
			if t, e := time.Parse(time.RFC3339Nano, p.ExpiresAt); e == nil && m.deps.Now().After(t) {
				out.ExpiredPages = append(out.ExpiredPages, p.Slug)
			}
		}
		for _, s := range p.Sources {
			var digest string
			if e := m.store.db.QueryRowContext(ctx, "SELECT digest FROM wiki_page_revisions WHERE page_id=? AND revision=?", s.PageID, s.Revision).Scan(&digest); e != nil || digest != s.Digest {
				out.InvalidSources = append(out.InvalidSources, p.Slug+" -> "+s.PageID+":"+strconv.Itoa(s.Revision))
			}
		}
	}
	return out, nil
}

func (m *Manager) ExportWiki(ctx context.Context, spaceID string) (WikiExport, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pages, err := m.listWikiPagesLocked(ctx, spaceID, true)
	if err != nil {
		return WikiExport{}, err
	}
	files := map[string]string{}
	var index, changes strings.Builder
	index.WriteString("# Wiki 索引\n\n")
	changes.WriteString("# 修订记录\n\n")
	sources := map[string][]WikiEvidence{}
	for _, p := range pages {
		files["pages/"+p.ID+".md"] = "# " + p.Title + "\n\n" + p.Markdown + "\n"
		index.WriteString("- [[" + p.ID + "]] " + p.Title + " (revision " + strconv.Itoa(p.Revision) + ", " + p.Status + ")\n")
		sources[p.ID] = p.Evidence
		revs, e := readDocuments[WikiPage](ctx, m.store.db, "SELECT document FROM wiki_page_revisions WHERE page_id=? ORDER BY revision", p.ID)
		if e != nil {
			return WikiExport{}, e
		}
		for _, rev := range revs {
			changes.WriteString("- " + p.ID + " revision " + strconv.Itoa(rev.Revision) + " " + rev.UpdatedAt + " " + rev.Digest + "\n")
		}
	}
	files["index.md"] = index.String()
	files["changelog.md"] = changes.String()
	manifest, _ := json.MarshalIndent(sources, "", "  ")
	files["sources.json"] = string(manifest)
	return WikiExport{Files: files}, nil
}
func (m *Manager) ImportWiki(ctx context.Context, spaceID string, files map[string]string) ([]WikiCandidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return nil, err
	}
	if len(files) == 0 || len(files) > 64 {
		return nil, bad("wiki-import-limit", "一次导入必须包含 1 至 64 个文件")
	}
	if _, err := m.ensureWikiSpaceLocked(ctx, spaceID); err != nil {
		return nil, err
	}
	out := []WikiCandidate{}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		md := files[name]
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		slug := strings.TrimSuffix(name, ".md")
		title := slug
		if strings.HasPrefix(md, "# ") {
			line := strings.SplitN(md, "\n", 2)
			title = strings.TrimSpace(strings.TrimPrefix(line[0], "# "))
			if len(line) > 1 {
				md = line[1]
			}
		}
		in := WikiPageInput{Slug: slug, Title: title, Markdown: strings.TrimSpace(md), Kind: "reference"}
		if err := validateWikiInput(in); err != nil {
			return out, err
		}
		c := WikiCandidate{ID: m.deps.NewID(), SpaceID: spaceID, Status: "pending", OriginKind: "markdown-import", OriginID: name, CreatedAt: wikiNow(m), Page: in}
		out = append(out, c)
	}
	err := m.store.write(ctx, "wiki-import-candidate", func(tx *sql.Tx) error {
		for _, c := range out {
			raw, _ := marshalWiki(c)
			_, e := tx.ExecContext(ctx, "INSERT INTO wiki_candidates(id,space_id,state,origin_kind,origin_id,document) VALUES(?,?,?,?,?,?)", c.ID, c.SpaceID, c.Status, c.OriginKind, c.OriginID, raw)
			if e != nil {
				return e
			}
		}
		return nil
	})
	return out, err
}
func (m *Manager) ListWikiCandidates(ctx context.Context, spaceID, status string) ([]WikiCandidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	q := `SELECT document FROM wiki_candidates WHERE (?='' OR space_id=?)`
	args := []any{spaceID, spaceID}
	if status != "" {
		q += ` AND state=?`
		args = append(args, status)
	}
	q += ` ORDER BY rowid DESC`
	rows, err := m.store.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WikiCandidate{}
	for rows.Next() {
		var raw string
		var c WikiCandidate
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (m *Manager) DecideWikiCandidate(ctx context.Context, id, decision string) (WikiCandidate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return WikiCandidate{}, err
	}
	if decision != "approved" && decision != "rejected" {
		return WikiCandidate{}, bad("invalid-decision", "候选决定必须为 approved 或 rejected")
	}
	var raw string
	err := m.store.db.QueryRowContext(ctx, "SELECT document FROM wiki_candidates WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return WikiCandidate{}, &Error{404, "wiki-candidate-not-found", "Wiki 候选不存在"}
	}
	if err != nil {
		return WikiCandidate{}, err
	}
	var c WikiCandidate
	if json.Unmarshal([]byte(raw), &c) != nil {
		return c, errors.New("Wiki 候选记录无效")
	}
	if c.Status != "pending" {
		if c.Status == decision {
			return c, nil
		}
		return c, &Error{409, "wiki-candidate-decided", "Wiki 候选已处理"}
	}
	err = m.store.write(ctx, "wiki-candidate-decision", func(tx *sql.Tx) error {
		invalid, err := wikiArtifactInvalid(ctx, tx, "candidate", c.ID)
		if err != nil {
			return err
		}
		if invalid {
			return &Error{409, "wiki-source-withdrawn", "候选来源已撤回，不能发布"}
		}
		if decision == "approved" {
			in := normalizeWikiInput(c.Page)
			if err := validateWikiInput(in); err != nil {
				return err
			}
			now := wikiNow(m)
			if in.Kind == "observation" && in.ExpiresAt == "" {
				in.ExpiresAt = stamp(m.deps.Now().Add(30 * 24 * time.Hour))
			}
			p := WikiPage{ID: c.PageID, SpaceID: c.SpaceID, Slug: in.Slug, Revision: in.ExpectedRevision + 1, Title: in.Title, Markdown: in.Markdown, Kind: in.Kind, Status: "active", Digest: wikiDigest(in.Title, in.Markdown), CreatedAt: now, UpdatedAt: now, ExpiresAt: in.ExpiresAt, Evidence: in.Evidence, Sources: in.Sources, Links: wikiLinks(in.Markdown)}
			p.Tags, p.Aliases = in.Tags, in.Aliases
			if c.PageID == "" {
				if in.ExpectedRevision != 0 {
					return &Error{409, "revision-conflict", "新增页面基准 revision 必须为零"}
				}
				p.ID = m.deps.NewID()
			} else {
				var oldRaw string
				if e := tx.QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=? AND space_id=?", c.PageID, c.SpaceID).Scan(&oldRaw); e != nil {
					return e
				}
				var old WikiPage
				if e := decodeWiki(oldRaw, &old); e != nil {
					return e
				}
				p.CreatedAt = old.CreatedAt
				p.Slug = old.Slug
			}
			if e := publishWikiPage(ctx, tx, &p, in.ExpectedRevision); e != nil {
				return e
			}
			c.PageID = p.ID
		}
		c.Status = decision
		c.DecidedAt = wikiNow(m)
		doc, _ := marshalWiki(c)
		_, e := tx.ExecContext(ctx, "UPDATE wiki_candidates SET state=?,document=? WHERE id=?", c.Status, doc, c.ID)
		return e
	})
	return c, err
}

// validateWikiRun is called at model/approval/dispatch/finish boundaries. Any
// invalidated source freezes the run before a new side effect can start.
func (m *Manager) validateWikiRun(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, runID string) error {
	var generation, invalidated int
	err := q.QueryRowContext(ctx, "SELECT generation,invalidated FROM wiki_artifacts WHERE kind='run' AND id=?", runID).Scan(&generation, &invalidated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if invalidated != 0 {
		return &Error{409, "wiki-context-invalidated", "运行引用的 Wiki 页面已撤回，请重新开始任务"}
	}
	return nil
}
