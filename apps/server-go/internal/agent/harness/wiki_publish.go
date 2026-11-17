package harness

import (
	"context"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (m *Manager) markWikiEvidence(ctx context.Context, p *WikiPage) error {
	for i := range p.Evidence {
		e := &p.Evidence[i]
		if e.Kind == "workflow" {
			var n int
			if err := readView(ctx, m.store).WorkflowExists(ctx, e.ID, &n); err != nil {
				return err
			}
			e.OriginalCleared = n == 0
			continue
		}
		if e.RunID == "" {
			continue
		}
		var n int
		if err := readView(ctx, m.store).WikiSourcesCleared(ctx, e.RunID, &n); err != nil {
			return err
		}
		e.OriginalCleared = n > 0
	}
	return nil
}

func (m *Manager) WikiSessionSelection(ctx context.Context, id string) (WikiSpaceSelection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return WikiSpaceSelection{}, closedError()
	}
	if _, err := readSession(ctx, m.store, id); err != nil {
		return WikiSpaceSelection{}, err
	}
	var raw string
	var out WikiSpaceSelection
	err := readView(ctx, m.store).WikiSessionSelection(ctx, id, &raw)
	if errors.Is(err, sessionstore.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	err = json.Unmarshal([]byte(raw), &out)
	return out, err
}
