package harness

import (
	"context"
	"encoding/json"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

func (m *Manager) UpdateWikiSpace(ctx context.Context, id string, expected int, name string) (WikiSpace, error) {
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.agentWritableLocked(guardErr); err != nil {
		return WikiSpace{}, err
	}
	s, err := m.ensureWikiSpaceLocked(ctx, id)
	if err != nil {
		return s, err
	}
	if s.Revision != expected {
		return s, &Error{Status: 409, Code: "revision-conflict", Message: "记忆空间版本已变化"}
	}
	if !wikiValidText(name, 120) {
		return s, bad("invalid-wiki-space", "记忆空间名称无效")
	}
	s.Revision++
	s.Name = name
	raw, _ := json.Marshal(s)
	err = writeStore(m.store, ctx, "wiki-space-revision", func(tx sessionstore.Tx) error {
		if _, e := tx.InsertWikiSpaceRevision(ctx, s.ID, s.Revision, string(raw)); e != nil {
			return e
		}
		_, e := tx.UpdateWikiSpace(ctx, s.Name, string(raw), s.ID)
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
	err := readView(ctx, m.store).WikiPageRevision(ctx, space, id, revision, &raw)
	if err == sessionstore.ErrNotFound {
		return p, &Error{Status: 404, Code: "wiki-revision-not-found", Message: "Wiki 页面修订不存在"}
	}
	if err != nil {
		return p, err
	}
	if err = state.DecodeWiki(raw, &p); err == nil {
		err = m.markWikiEvidence(ctx, &p)
	}
	return p, err
}
