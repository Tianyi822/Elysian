package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParentPreservesFileDownloadAbort(t *testing.T) {
	w := httptest.NewRecorder()
	handler := parentErrorHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("partial"))
		panic(http.ErrAbortHandler)
	}), &fakeLogsService{})
	defer func() {
		if value := recover(); value != http.ErrAbortHandler {
			t.Errorf("流式中断被改写：%v", value)
		}
		if w.Body.String() != "partial" {
			t.Errorf("附件流被追加 JSON：%q", w.Body.String())
		}
	}()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/files/downloads/id", nil))
}
