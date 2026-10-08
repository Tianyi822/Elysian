package auth

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSingleLoginReplacesLegacySessions(t *testing.T) {
	store := NewFileSessionStore(sessionFilePath(tempDir(t)), nil)
	var oldIDs []string
	for range 3 {
		old, err := seedLegacySession(store, testEpoch)
		if err != nil {
			t.Fatal(err)
		}
		oldIDs = append(oldIDs, old.ID)
	}
	current, replaced, err := store.Create(testEpoch)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(replaced, oldIDs) {
		t.Fatalf("应撤销全部遗留会话：%v", replaced)
	}
	listed, err := store.List()
	if err != nil || len(listed) != 1 || listed[0].ID != current.ID {
		t.Fatalf("应只保留新会话：%v，错误 %v", listed, err)
	}
}

func TestSingleLoginConcurrentCreatesKeepOneSession(t *testing.T) {
	for _, mode := range []string{"memory", "file"} {
		t.Run(mode, func(t *testing.T) {
			store := NewMemorySessionStore(nil)
			path := sessionFilePath(tempDir(t))
			if mode == "file" {
				store = NewFileSessionStore(path, nil)
			}
			const count = 16
			type result struct {
				session  *PanelSession
				replaced []string
				err      error
			}
			results := make(chan result, count)
			start := make(chan struct{})
			var wg sync.WaitGroup
			for range count {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					session, replaced, err := store.Create(testEpoch)
					results <- result{session, replaced, err}
				}()
			}
			close(start)
			wg.Wait()
			close(results)
			listed, err := store.List()
			if err != nil || len(listed) != 1 {
				t.Fatalf("并发登录后只能有一个会话：%v，错误 %v", listed, err)
			}
			revoked := map[string]int{}
			for r := range results {
				if r.err != nil {
					t.Fatal(r.err)
				}
				valid, err := store.Validate(r.session.ID, testEpoch)
				if err != nil || (valid != nil) != (r.session.ID == listed[0].ID) {
					t.Fatalf("只能校验通过最终会话，错误 %v", err)
				}
				for _, id := range r.replaced {
					revoked[id]++
				}
			}
			if len(revoked) != count-1 || revoked[listed[0].ID] != 0 {
				t.Fatal("替换清单必须覆盖所有旧会话且不含最终会话")
			}
			for _, count := range revoked {
				if count != 1 {
					t.Fatal("每个旧会话只能被替换一次")
				}
			}
			if mode == "file" {
				onDisk := readSessionsOnDisk(t, path)
				if len(onDisk.ids) != 1 || onDisk.ids[0] != listed[0].ID {
					t.Fatal("并发登录的磁盘结果与内存不一致")
				}
			}
		})
	}
}

func TestSingleLoginNewLoginInvalidatesOldCookieAndConnections(t *testing.T) {
	admin := `{"username":"admin","password":"e2e-password"}`
	dev := `{"username":"dev","password":"dev-elysian"}`
	for _, tc := range []struct{ name, first, second string }{
		{"admin", admin, admin}, {"dev", dev, dev},
		{"admin-to-dev", admin, dev}, {"dev-to-admin", dev, admin},
	} {
		t.Run(tc.name, func(t *testing.T) {
			connections := NewSessionConnections()
			client, _ := newWiringFixture(t, func(deps *Deps) {
				deps.DevAccount = true
				deps.SessionConns = connections
			})
			first := client.postJSON("/api/auth/login", tc.first, "")
			if first.Code != http.StatusOK {
				t.Fatalf("首次登录失败：%d", first.Code)
			}
			oldCookie := cookiePair(first.Header().Get("Set-Cookie"))
			closed := 0
			for range 2 {
				connections.Register(strings.TrimPrefix(oldCookie, "elysian_session="), func() { closed++ })
			}
			second := client.postJSON("/api/auth/login", tc.second, "")
			if second.Code != http.StatusOK {
				t.Fatalf("新登录失败：%d", second.Code)
			}
			newCookie := cookiePair(second.Header().Get("Set-Cookie"))
			if closed != 2 {
				t.Fatalf("旧会话的全部连接应关闭：%d", closed)
			}
			if strings.Contains(client.get("/api/auth/session", oldCookie).Body.String(), `"authenticated":true`) {
				t.Fatal("旧 Cookie 的 SSO 探测仍通过")
			}
			if strings.Contains(client.get("/api/auth/session?passive=1", oldCookie).Body.String(), `"authenticated":true`) {
				t.Fatal("旧 Cookie 的后台探测仍通过")
			}
			for _, path := range []string{"/api/logs/runtime", "/api/docker/events", "/api/terminals/ws", "/api/docker/containers/a/terminal", "/api/databases/a/terminal"} {
				if status := client.get(path, oldCookie).Code; status != http.StatusUnauthorized {
					t.Errorf("旧会话访问 %s = %d，期望 401", path, status)
				}
			}
			if status := client.post("/api/auth/sessions/logout-others", oldCookie).Code; status != http.StatusUnauthorized {
				t.Fatalf("旧会话仍可执行写操作：%d", status)
			}
			// 旧浏览器点退出不能退出新浏览器；共享新 Cookie 的多个标签页均可访问。
			client.post("/api/auth/logout", oldCookie)
			for range 2 {
				if status := client.get("/api/logs/runtime", newCookie).Code; status != http.StatusOK {
					t.Errorf("新会话不可用：%d", status)
				}
			}
		})
	}
}

func TestSingleLoginFailureKeepsOldSession(t *testing.T) {
	for _, failure := range []string{"password", "body", "rate-limit", "persist"} {
		t.Run(failure, func(t *testing.T) {
			path := sessionFilePath(tempDir(t))
			store := NewFileSessionStore(path, nil)
			connections := NewSessionConnections()
			client, _ := newWiringFixture(t, func(deps *Deps) {
				deps.Sessions = store
				deps.SessionConns = connections
				if failure == "rate-limit" {
					deps.LoginRateLimit = 1
				}
			})
			body := `{"username":"admin","password":"e2e-password"}`
			first := client.postJSON("/api/auth/login", body, "")
			if first.Code != http.StatusOK {
				t.Fatalf("首次登录失败：%d", first.Code)
			}
			cookie := cookiePair(first.Header().Get("Set-Cookie"))
			closed := false
			connections.Register(strings.TrimPrefix(cookie, "elysian_session="), func() { closed = true })
			want := http.StatusUnauthorized
			switch failure {
			case "password":
				body = `{"username":"admin","password":"wrong"}`
			case "body":
				body, want = `{}`, http.StatusBadRequest
			case "rate-limit":
				want = http.StatusTooManyRequests
			case "persist":
				want = http.StatusInternalServerError
				store.(*sessionStoreCore).writer = func([]PanelSession) error { return errors.New("模拟会话写入失败") }
			}
			failed := client.postJSON("/api/auth/login", body, "")
			if failed.Code != want || failed.Header().Get("Set-Cookie") != "" {
				t.Fatalf("失败登录不应发 Cookie：状态 %d，期望 %d", failed.Code, want)
			}
			if closed || client.get("/api/logs/runtime", cookie).Code != http.StatusOK {
				t.Fatal("失败登录影响了原会话或连接")
			}
			restarted := NewFileSessionStore(path, nil)
			old, err := restarted.Validate(strings.TrimPrefix(cookie, "elysian_session="), testEpoch)
			if err != nil || old == nil {
				t.Fatalf("失败登录后磁盘原会话不可用：%v", err)
			}
		})
	}
}

func TestSingleLoginPassiveChecksDoNotExtendIdleExpiry(t *testing.T) {
	for _, passive := range []bool{true, false} {
		t.Run(fmt.Sprint(passive), func(t *testing.T) {
			clock := &fakeClock{ms: 1_760_000_000_000}
			store := NewMemorySessionStore(clock.now)
			client, _ := newWiringFixture(t, func(deps *Deps) {
				deps.Now, deps.Sessions = clock.now, store
			})
			first := client.postJSON("/api/auth/login", `{"username":"admin","password":"e2e-password"}`, "")
			if first.Code != http.StatusOK {
				t.Fatalf("登录失败：%d", first.Code)
			}
			cookie := cookiePair(first.Header().Get("Set-Cookie"))
			path := "/api/auth/session"
			if passive {
				path += "?passive=1"
			}
			for range 2 {
				clock.ms += (SessionIdleTTL / 2).Milliseconds()
				if response := client.get(path, cookie); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"authenticated":true`) {
					t.Fatal("空闲期限内会话应有效")
				}
			}
			clock.ms++
			response := client.get("/api/auth/session?passive=1", cookie)
			authenticated := strings.Contains(response.Body.String(), `"authenticated":true`)
			if response.Code != http.StatusOK || authenticated == passive {
				t.Fatal("后台检查不得续期，正常 SSO 探测仍应续期")
			}
		})
	}
}

// delayedCreateStore 在写入之后延迟首个登录响应，确定性复现撤销顺序与登录顺序相反。
type delayedCreateStore struct {
	SessionStore
	created chan struct{}
	resume  chan struct{}
	mu      sync.Mutex
	first   bool
}

func (s *delayedCreateStore) Create(epoch string) (*PanelSession, []string, error) {
	current, replaced, err := s.SessionStore.Create(epoch)
	s.mu.Lock()
	first := !s.first
	s.first = true
	s.mu.Unlock()
	if first {
		close(s.created)
		<-s.resume
	}
	return current, replaced, err
}

func TestSingleLoginDelayedRevocationKeepsLatestConnections(t *testing.T) {
	store := &delayedCreateStore{SessionStore: NewMemorySessionStore(nil), created: make(chan struct{}), resume: make(chan struct{})}
	connections := NewSessionConnections()
	client, _ := newWiringFixture(t, func(deps *Deps) {
		deps.Sessions, deps.SessionConns, deps.Hasher = store, connections, NewScryptHasher()
	})
	body := `{"username":"admin","password":"e2e-password"}`
	firstDone := make(chan *httptest.ResponseRecorder, 1)
	var resume sync.Once
	defer resume.Do(func() { close(store.resume) })
	go func() { firstDone <- client.postJSON("/api/auth/login", body, "") }()
	select {
	case <-store.created:
	case <-time.After(5 * time.Second):
		t.Fatal("首个登录未完成会话写入")
	}
	second := client.postJSON("/api/auth/login", body, "")
	if second.Code != http.StatusOK {
		t.Fatalf("第二个登录失败：%d", second.Code)
	}
	cookie := cookiePair(second.Header().Get("Set-Cookie"))
	closed := false
	connections.Register(strings.TrimPrefix(cookie, "elysian_session="), func() { closed = true })
	resume.Do(func() { close(store.resume) })
	select {
	case first := <-firstDone:
		if first.Code != http.StatusOK {
			t.Fatalf("首个登录失败：%d", first.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("首个登录未返回")
	}
	if closed || client.get("/api/logs/runtime", cookie).Code != http.StatusOK {
		t.Fatal("较早登录的延迟撤销误伤了最新会话")
	}
}
