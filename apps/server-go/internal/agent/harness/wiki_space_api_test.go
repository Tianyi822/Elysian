package harness

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"elysian/server/internal/agent/harness/sessionstore"
)

type wikiRevisionErrorStore struct {
	sessionstore.SessionStore
	err error
}

func (s wikiRevisionErrorStore) WikiPageRevision(context.Context, string, string, int, *string) error {
	return s.err
}

func TestWikiPageRevisionPreservesNotFoundAcrossStoreWrapping(t *testing.T) {
	ctx := context.Background()
	for _, missing := range []error{sessionstore.ErrNotFound, fmt.Errorf("读取修订：%w", sessionstore.ErrNotFound)} {
		m := &Manager{store: wikiRevisionErrorStore{err: missing}}
		_, err := m.WikiPageRevision(ctx, "space", "page", 1)
		var apiErr *Error
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound || apiErr.Code != "wiki-revision-not-found" || apiErr.Message != "Wiki 页面修订不存在" {
			t.Fatalf("错误 %v 未保留原 404 契约：%+v", missing, err)
		}
	}
	storageErr := errors.New("读取失败")
	m := &Manager{store: wikiRevisionErrorStore{err: storageErr}}
	if _, err := m.WikiPageRevision(ctx, "space", "page", 1); err != storageErr {
		t.Fatalf("其它读取错误不得投影为未找到：%v", err)
	}
}
