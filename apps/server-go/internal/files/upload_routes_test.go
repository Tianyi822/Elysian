package files

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadHTTPCheckAndStream(t *testing.T) {
	m := testTransferManager(t)
	router := NewRouter(Deps{Available: true, service: &recordingService{}, Transfers: m})
	dir := t.TempDir()
	name := "文件+% 压缩包.zip"
	payload := []byte{'P', 'K', 0, 0xff, '\n'}
	request := func(method, path, contentType, session, origin string, body []byte, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost"+path, bytes.NewReader(body))
		r.Header.Set("Content-Type", contentType)
		r.Header.Set("Origin", origin)
		if session != "" {
			r.Header.Set("Cookie", "elysian_session="+session)
		}
		if token != "" {
			r.Header.Set("X-Elysian-Upload-Token", token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	checkJSON, _ := json.Marshal(map[string]any{"dirPath": dir, "name": name, "sizeBytes": len(payload)})
	w := request(http.MethodPost, "/uploads/check", "application/json", "test-session", "http://localhost", checkJSON, "")
	if w.Code != http.StatusOK {
		t.Fatalf("check: %d %s", w.Code, w.Body.String())
	}
	var check uploadCheckResult
	if err := json.Unmarshal(w.Body.Bytes(), &check); err != nil || check.State != "create" || check.Token == "" {
		t.Fatalf("check shape: %s %v", w.Body.String(), err)
	}
	path := "/upload?" + url.Values{"dirPath": {dir}, "name": {name}}.Encode()
	w = request(http.MethodPut, path, "application/octet-stream", "test-session", "http://localhost", payload, check.Token)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	var uploaded entryResponse
	if err := json.Unmarshal(w.Body.Bytes(), &uploaded); err != nil || uploaded.Entry.Name != name {
		t.Fatalf("upload shape: %s %v", w.Body.String(), err)
	}
	actual, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || !bytes.Equal(actual, payload) {
		t.Fatalf("upload bytes: %v %v", actual, err)
	}
	w = request(http.MethodPut, path, "application/octet-stream", "test-session", "http://localhost", payload, check.Token)
	if w.Code != http.StatusConflict {
		t.Fatalf("replay: %d %s", w.Code, w.Body.String())
	}
	w = request(http.MethodPost, "/uploads/check", "application/json", "test-session", "http://localhost", checkJSON, "")
	if err := json.Unmarshal(w.Body.Bytes(), &check); err != nil || check.State != "replace" || check.Existing == nil {
		t.Fatalf("replace shape: %s %v", w.Body.String(), err)
	}
	w = request(http.MethodPut, path, "application/octet-stream", "test-session", "http://localhost", payload, check.Token)
	if w.Code != http.StatusConflict {
		t.Fatalf("missing overwrite confirmation: %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		label, contentType, session, origin string
		status                              int
	}{
		{"unsigned", "application/octet-stream", "", "http://localhost", 401},
		{"cross-origin", "application/octet-stream", "test-session", "http://elsewhere", 403},
		{"wrong-type", "application/json", "test-session", "http://localhost", 415},
	} {
		t.Run(tc.label, func(t *testing.T) {
			w := request(http.MethodPut, path, tc.contentType, tc.session, tc.origin, payload, check.Token)
			if w.Code != tc.status {
				t.Fatalf("want %d got %d %s", tc.status, w.Code, w.Body.String())
			}
		})
	}
	uploadTestClean(t, dir)
}
