package harness

import (
	"context"
	"database/sql"
	"encoding/json"
)

func (m *Manager) UpdateWikiSpace(ctx context.Context, id string, expected int, name string) (WikiSpace, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.workflowWritable(); err != nil {
		return WikiSpace{}, err
	}
	s, err := m.ensureWikiSpaceLocked(ctx, id)
	if err != nil {
		return s, err
	}
	if s.Revision != expected {
		return s, &Error{409, "revision-conflict", "记忆空间版本已变化"}
	}
	if !wikiValidText(name, 120) {
		return s, bad("invalid-wiki-space", "记忆空间名称无效")
	}
	s.Revision++
	s.Name = name
	raw, _ := json.Marshal(s)
	err = m.store.write(ctx, "wiki-space-revision", func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(ctx, "INSERT INTO wiki_space_revisions(id,revision,document) VALUES(?,?,?)", s.ID, s.Revision, string(raw)); e != nil {
			return e
		}
		_, e := tx.ExecContext(ctx, "UPDATE wiki_spaces SET name=?,document=? WHERE id=?", s.Name, string(raw), s.ID)
		return e
	})
	return s, err
}

func (m *Manager) WikiPageRevision(ctx context.Context, space, id string, revision int) (WikiPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WikiPage{}, closedError()
	}
	var p WikiPage
	var raw string
	err := m.store.db.QueryRowContext(ctx, `SELECT r.document FROM wiki_page_revisions r JOIN wiki_pages p ON p.id=r.page_id WHERE p.space_id=? AND r.page_id=? AND r.revision=?`, space, id, revision).Scan(&raw)
	if err == sql.ErrNoRows {
		return p, &Error{404, "wiki-revision-not-found", "Wiki 页面修订不存在"}
	}
	if err != nil {
		return p, err
	}
	if err = decodeWiki(raw, &p); err == nil {
		err = m.markWikiEvidence(ctx, &p)
	}
	return p, err
}
