package auth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

// 会话存储测试（sessionStore.test.ts 对等用例）：注入临时目录与可控时钟，锚定
// 43 字符 base64url 会话 id、滑动续期、空闲/绝对/epoch 三种失效、惰性清扫、重启
// 持久化与文件权限、「何时不写文件」的落盘时机。

const laterEpoch = "2026-10-01T00:00:00.000Z"

// fakeClock 可控时钟：now 毫秒可移动。
type fakeClock struct{ ms int64 }

func (c *fakeClock) now() time.Time { return time.UnixMilli(c.ms) }

func sessionFilePath(dir string) string {
	return filepath.Join(dir, "state", "panel-sessions.json")
}

// seedLegacySession 仅供兼容测试构造遗留的多会话文件；登录入口始终只创建单会话。
func seedLegacySession(store SessionStore, epoch string) (*PanelSession, error) {
	core := store.(*sessionStoreCore)
	core.mu.Lock()
	defer core.mu.Unlock()
	loaded, err := core.load()
	if err != nil {
		return nil, err
	}
	at := core.now().UnixMilli()
	session := PanelSession{ID: newSessionID(), CreatedAt: at, LastUsedAt: at, PwdEpoch: epoch}
	next := append(append([]PanelSession{}, loaded...), session)
	if err := core.commit(next, true); err != nil {
		return nil, err
	}
	return &session, nil
}

func readSessionsOnDisk(t *testing.T, path string) sessionsOnDisk {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	var parsed struct {
		Version  int `json:"version"`
		Sessions []struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("解析会话文件失败：%v（原文 %s）", err, data)
	}
	ids := make([]string, 0, len(parsed.Sessions))
	for _, session := range parsed.Sessions {
		ids = append(ids, session.ID)
	}
	return sessionsOnDisk{version: parsed.Version, ids: ids, raw: string(data)}
}

type sessionsOnDisk struct {
	version int
	ids     []string
	raw     string
}

func TestSessionStoreCreateShapeAndPermissions(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	store := NewFileSessionStore(path, nil)

	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(session.ID) {
		t.Errorf("会话 id 不是 43 字符 base64url：%q", session.ID)
	}
	if session.PwdEpoch != testEpoch {
		t.Errorf("PwdEpoch = %q，期望 %q", session.PwdEpoch, testEpoch)
	}
	if session.LastUsedAt != session.CreatedAt {
		t.Errorf("LastUsedAt(%d) != CreatedAt(%d)", session.LastUsedAt, session.CreatedAt)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("文件权限 = %o，期望 0600", fi.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat 目录失败：%v", err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("目录权限 = %o，期望 0700", dirInfo.Mode().Perm())
	}
	onDisk := readSessionsOnDisk(t, path)
	if onDisk.version != 1 || len(onDisk.ids) != 1 {
		t.Errorf("落盘形状不符：version %d、sessions %v", onDisk.version, onDisk.ids)
	}
}

func TestSessionStoreReplacementAndSliding(t *testing.T) {
	dir := tempDir(t)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(sessionFilePath(dir), clock.now)

	first, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("第一次 Create 失败：%v", err)
	}
	clock.ms += 1000
	second, replaced, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("第二次 Create 失败：%v", err)
	}
	if first.ID == second.ID {
		t.Error("两次 create 产出相同 id")
	}

	if len(replaced) != 1 || replaced[0] != first.ID {
		t.Fatalf("替换清单应只含旧会话：%v", replaced)
	}
	if old, err := store.Validate(first.ID, testEpoch); err != nil || old != nil {
		t.Fatalf("旧会话仍有效或校验失败：%v", err)
	}
	onDisk := readSessionsOnDisk(t, sessionFilePath(dir))
	if len(onDisk.ids) != 1 || onDisk.ids[0] != second.ID {
		t.Fatalf("磁盘应只保留新会话：%v", onDisk.ids)
	}
	restarted := NewFileSessionStore(sessionFilePath(dir), clock.now)
	if old, err := restarted.Validate(first.ID, testEpoch); err != nil || old != nil {
		t.Fatalf("重启后旧会话仍有效或校验失败：%v", err)
	}
	if current, err := restarted.Validate(second.ID, testEpoch); err != nil || current == nil {
		t.Fatalf("重启后新会话不可用：%v", err)
	}

	clock.ms += 60_000
	validated, err := store.Validate(second.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Fatal("Validate 回 nil，期望有效")
	}
	if validated.LastUsedAt != clock.ms {
		t.Errorf("滑动后 LastUsedAt = %d，期望 %d", validated.LastUsedAt, clock.ms)
	}
	if validated.CreatedAt != second.CreatedAt {
		t.Errorf("CreatedAt 被改动：%d ≠ %d", validated.CreatedAt, second.CreatedAt)
	}
}

func TestSessionStoreIdleExpiryBoundary(t *testing.T) {
	dir := tempDir(t)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(sessionFilePath(dir), clock.now)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}

	clock.ms += int64(SessionIdleTTL/time.Millisecond) - 1
	// 边界内（差 1ms）有效。
	validated, err := store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("差 1ms 时应当仍有效（严格大于才过期）")
	}

	clock.ms += int64(SessionIdleTTL/time.Millisecond) + 1
	// 距最近一次使用已超 12 小时：删除并回 nil；删除已落盘，再校验同样回 null。
	for i := 0; i < 2; i++ {
		validated, err = store.Validate(session.ID, testEpoch)
		if err != nil {
			t.Fatalf("Validate 失败：%v", err)
		}
		if validated != nil {
			t.Fatalf("超时空闲后第 %d 次 Validate 应回 nil", i+1)
		}
	}
}

func TestSessionStoreSlidingKeepsAlive(t *testing.T) {
	dir := tempDir(t)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(sessionFilePath(dir), clock.now)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	for i := 1; i <= 20; i++ {
		clock.ms += int64(SessionIdleTTL/time.Millisecond) / 2
		validated, err := store.Validate(session.ID, testEpoch)
		if err != nil {
			t.Fatalf("第 %d 轮 Validate 失败：%v", i, err)
		}
		if validated == nil {
			t.Fatalf("第 %d 轮滑动后续期应当有效", i)
		}
	}
}

func TestSessionStoreAbsoluteExpiry(t *testing.T) {
	dir := tempDir(t)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(sessionFilePath(dir), clock.now)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	// 每小时活动一次，直到绝对上限边界。
	for clock.ms < session.CreatedAt+int64(SessionAbsoluteTTL/time.Millisecond)-1 {
		clock.ms += 60 * 60 * 1000
		if _, err := store.Validate(session.ID, testEpoch); err != nil {
			t.Fatalf("Validate 失败：%v", err)
		}
	}
	clock.ms = session.CreatedAt + int64(SessionAbsoluteTTL/time.Millisecond) + 1
	validated, err := store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("绝对上限 7 天超时即删，无论活跃")
	}
}

func TestSessionStoreEpochMismatch(t *testing.T) {
	dir := tempDir(t)
	store := NewFileSessionStore(sessionFilePath(dir), nil)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	validated, err := store.Validate(session.ID, laterEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("epoch 不匹配（CLI 已改密）应删除回 nil")
	}
	validated, err = store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("再次 Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("epoch 失效后的会话已删除，再校验仍回 nil")
	}
}

func TestSessionStoreDestroy(t *testing.T) {
	dir := tempDir(t)
	store := NewFileSessionStore(sessionFilePath(dir), nil)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	if err := store.Destroy(session.ID); err != nil {
		t.Fatalf("Destroy 失败：%v", err)
	}
	validated, err := store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("destroy 后 validate 应回 nil")
	}
	if err := store.Destroy("no-such-id"); err != nil {
		t.Errorf("destroy 不存在的 id 应是 no-op：%v", err)
	}
}

func TestSessionStoreListDoesNotWrite(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(path, clock.now)
	stale, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	clock.ms += int64(SessionIdleTTL/time.Millisecond) + 1
	fresh, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	listed, err := store.List()
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	if string(before) != string(after) {
		t.Error("list 不落盘：调用前后文件内容应当不变")
	}
	if len(listed) != 1 || listed[0].ID != fresh.ID {
		t.Errorf("list 只回未过期会话：%v（stale=%s fresh=%s）", listed, stale.ID, fresh.ID)
	}
	onDisk := readSessionsOnDisk(t, path)
	if len(onDisk.ids) != 2 {
		t.Errorf("磁盘上两者都在（list 不触发清扫）：%v", onDisk.ids)
	}
}

func TestSessionStoreDestroyOthers(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	store := NewFileSessionStore(path, nil)
	first, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	second, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	third, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}

	if err := store.DestroyOthers(second.ID); err != nil {
		t.Fatalf("DestroyOthers 失败：%v", err)
	}
	onDisk := readSessionsOnDisk(t, path)
	if len(onDisk.ids) != 1 || onDisk.ids[0] != second.ID {
		t.Errorf("destroyOthers 后磁盘只留 keep：%v", onDisk.ids)
	}

	// 重启（新实例同路径）：销毁结果可见。
	restarted := NewFileSessionStore(path, nil)
	for id, expectValid := range map[string]bool{first.ID: false, second.ID: true, third.ID: false} {
		validated, err := restarted.Validate(id, testEpoch)
		if err != nil {
			t.Fatalf("重启后 Validate 失败：%v", err)
		}
		if (validated != nil) != expectValid {
			t.Errorf("重启后 Validate(%s) 有效=%v，期望 %v", id, validated != nil, expectValid)
		}
	}
}

func TestSessionStoreDestroyOthersNoChangeNoWrite(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	store := NewFileSessionStore(path, nil)
	only, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	if err := store.DestroyOthers(only.ID); err != nil {
		t.Fatalf("DestroyOthers 失败：%v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	if string(before) != string(after) {
		t.Error("没有其他会话时 destroyOthers 不应写文件")
	}
	validated, err := store.Validate(only.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("keep 会话仍有效")
	}
}

func TestSessionStoreLazySweep(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewFileSessionStore(path, clock.now)
	stale, err := seedLegacySession(store, testEpoch) // t0 创建，此后不再使用
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	clock.ms += int64(SessionIdleTTL/time.Millisecond) + 1 // stale 的空闲窗口已超
	active, err := seedLegacySession(store, testEpoch)     // 刚创建，必然有效
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}

	validated, err := store.Validate(active.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Fatal("active 会话应有效")
	}
	onDisk := readSessionsOnDisk(t, path)
	if len(onDisk.ids) != 1 || onDisk.ids[0] != active.ID {
		t.Errorf("惰性清扫应剔除磁盘上的过期会话：%v", onDisk.ids)
	}
	validated, err = store.Validate(stale.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("被清扫的 stale 会话回 nil")
	}
}

func TestSessionStoreRestartKeepsSessions(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	first := NewFileSessionStore(path, nil)
	session, _, err := first.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	second := NewFileSessionStore(path, nil)
	validated, err := second.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("重启后 Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("重启（新 store 实例同路径）会话仍有效")
	}
}

func TestSessionStoreCorruptFileFailClosed(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	store := NewFileSessionStore(path, nil)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	onDisk := readSessionsOnDisk(t, path)
	if len(onDisk.ids) != 1 {
		t.Fatalf("落盘形状不符：%v", onDisk.ids)
	}

	// 会话文件只有面板进程一个写者（CLI 不碰它）；损坏只能发生在进程之外，
	// 因此按「重启后首次加载」的语义断言：新实例读到坏文件 → 空表 → fail closed。
	if err := os.WriteFile(path, []byte("{corrupt"), 0o600); err != nil {
		t.Fatalf("写坏文件失败：%v", err)
	}
	restarted := NewFileSessionStore(path, nil)
	validated, err := restarted.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("坏 JSON 按空表 fail closed，validate 回 nil")
	}
	rebuilt, _, err := restarted.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("重建失败：%v", err)
	}
	validated, err = restarted.Validate(rebuilt.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("create 可重建")
	}
}

func TestMemorySessionStoreSemantics(t *testing.T) {
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewMemorySessionStore(clock.now)
	session, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(session.ID) {
		t.Errorf("会话 id 不是 43 字符 base64url：%q", session.ID)
	}
	clock.ms += 60_000
	validated, err := store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Fatal("滑动窗口内应有效")
	}
	clock.ms += int64(SessionIdleTTL/time.Millisecond) + 1
	second, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	validated, err = store.Validate(session.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("空闲超时后回 nil")
	}
	validated, err = store.Validate(second.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("second 仍有效")
	}
	if err := store.Destroy(second.ID); err != nil {
		t.Fatalf("Destroy 失败：%v", err)
	}
	validated, err = store.Validate(second.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("destroy 后回 nil")
	}
}

func TestMemorySessionStoreListAndDestroyOthers(t *testing.T) {
	clock := &fakeClock{ms: 1_760_000_000_000}
	store := NewMemorySessionStore(clock.now)
	first, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	clock.ms += 60_000
	second, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	listed, err := store.List()
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	if len(listed) != 2 || listed[0].ID != first.ID || listed[1].ID != second.ID {
		t.Errorf("全部未过期：视图两行齐全，得 %v", listed)
	}

	// first 距上次使用已超 12h，second 还差半分钟未超时。
	clock.ms += int64(SessionIdleTTL/time.Millisecond) - 30_000
	third, err := seedLegacySession(store, testEpoch)
	if err != nil {
		t.Fatalf("Create 失败：%v", err)
	}
	listed, err = store.List()
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	if len(listed) != 2 || listed[0].ID != second.ID || listed[1].ID != third.ID {
		t.Errorf("过期过滤后只剩 second/third，得 %v", listed)
	}

	if err := store.DestroyOthers(third.ID); err != nil {
		t.Fatalf("DestroyOthers 失败：%v", err)
	}
	listed, err = store.List()
	if err != nil {
		t.Fatalf("List 失败：%v", err)
	}
	if len(listed) != 1 || listed[0].ID != third.ID {
		t.Errorf("destroyOthers 后只剩 third，得 %v", listed)
	}
	validated, err := store.Validate(second.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated != nil {
		t.Error("second 已被销毁")
	}
	validated, err = store.Validate(third.ID, testEpoch)
	if err != nil {
		t.Fatalf("Validate 失败：%v", err)
	}
	if validated == nil {
		t.Error("third 保留有效")
	}
}

// —— 会话客户端类别分道（ADR-0022 修订）：web 与 cli 各一把单槽锁 ——

func TestSessionStoreClientChanneling(t *testing.T) {
	for _, mode := range []string{"memory", "file"} {
		t.Run(mode, func(t *testing.T) {
			var store SessionStore
			var path string
			if mode == "file" {
				path = sessionFilePath(tempDir(t))
				store = NewFileSessionStore(path, nil)
			} else {
				store = NewMemorySessionStore(nil)
			}
			web1, replaced, err := store.Create(testEpoch, SessionClientWeb)
			if err != nil {
				t.Fatal(err)
			}
			if len(replaced) != 0 {
				t.Fatalf("首次 web 登录的替换清单应为空：%v", replaced)
			}

			// cli 登录不替换 web：清单为空、web 仍有效。
			cli1, replaced, err := store.Create(testEpoch, SessionClientCLI)
			if err != nil {
				t.Fatal(err)
			}
			if len(replaced) != 0 {
				t.Fatalf("cli 登录不得替换 web 会话：%v", replaced)
			}
			if cli1.Client != SessionClientCLI {
				t.Errorf("cli 会话的 Client = %q", cli1.Client)
			}
			if session, err := store.Validate(web1.ID, testEpoch); err != nil || session == nil {
				t.Fatalf("cli 登录后 web 会话应存活：(%v, %v)", session, err)
			}

			// web 重新登录：只替换同类 web，cli 幸存。
			web2, replaced, err := store.Create(testEpoch, SessionClientWeb)
			if err != nil {
				t.Fatal(err)
			}
			if len(replaced) != 1 || replaced[0] != web1.ID {
				t.Fatalf("web 重登的替换清单应只含旧 web：%v", replaced)
			}
			if session, err := store.Validate(cli1.ID, testEpoch); err != nil || session == nil {
				t.Fatalf("web 重登后 cli 会话应存活：(%v, %v)", session, err)
			}

			// 新 cli 登录顶掉旧 cli，web 不受影响。
			cli2, replaced, err := store.Create(testEpoch, SessionClientCLI)
			if err != nil {
				t.Fatal(err)
			}
			if len(replaced) != 1 || replaced[0] != cli1.ID {
				t.Fatalf("cli 重登的替换清单应只含旧 cli：%v", replaced)
			}
			if session, err := store.Validate(web2.ID, testEpoch); err != nil || session == nil {
				t.Fatalf("cli 重登后 web 会话应存活：(%v, %v)", session, err)
			}
			if session, err := store.Validate(cli1.ID, testEpoch); err != nil || session != nil {
				t.Fatalf("旧 cli 会话应已失效：(%v, %v)", session, err)
			}

			// 非法类别回落 web（fail-safe）：替换 web2，不动 cli2。
			fallback, replaced, err := store.Create(testEpoch, "tui")
			if err != nil {
				t.Fatal(err)
			}
			if len(replaced) != 1 || replaced[0] != web2.ID {
				t.Fatalf("非法类别应按 web 替换同类：%v", replaced)
			}
			if fallback.Client != SessionClientWeb {
				t.Errorf("非法类别回落 web，Client = %q", fallback.Client)
			}
			if session, err := store.Validate(cli2.ID, testEpoch); err != nil || session == nil {
				t.Fatalf("非法类别登录后 cli 会话应存活：(%v, %v)", session, err)
			}

			listed, err := store.List()
			if err != nil || len(listed) != 2 {
				t.Fatalf("最终恰两条会话（web + cli）：%v，错误 %v", listed, err)
			}
			if mode == "file" {
				onDisk := readSessionsOnDisk(t, path)
				if len(onDisk.ids) != 2 {
					t.Fatalf("磁盘与内存一致（两条会话）：%v", onDisk.ids)
				}
			}
		})
	}
}

// legacySessionsFile 手写旧版会话文件（无 client 键），复刻升级前的落盘形状。
func legacySessionsFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("建 state 目录失败：%v", err)
	}
	legacy := `{
  "version": 1,
  "sessions": [
    {
      "id": "legacy-web-session-00000000000000000000000",
      "createdAt": 1760000000000,
      "lastUsedAt": 1760000000000,
      "pwdEpoch": "` + testEpoch + `"
    }
  ]
}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("写旧版会话文件失败：%v", err)
	}
}

func TestSessionStoreLegacyFileReadsAsWeb(t *testing.T) {
	const legacyID = "legacy-web-session-00000000000000000000000"
	// 注入时钟贴合文件时间戳，避免真实时钟把旧版会话判为空闲过期。
	clock := &fakeClock{ms: 1_760_000_060_000}

	// 旧文件无 client 字段判 web：web 登录替换它。
	path := sessionFilePath(tempDir(t))
	legacySessionsFile(t, path)
	webStore := NewFileSessionStore(path, clock.now)
	_, replaced, err := webStore.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatal(err)
	}
	if len(replaced) != 1 || replaced[0] != legacyID {
		t.Fatalf("web 登录应替换旧版（判 web）会话：%v", replaced)
	}

	// cli 登录保留旧版会话。
	path = sessionFilePath(tempDir(t))
	legacySessionsFile(t, path)
	cliStore := NewFileSessionStore(path, clock.now)
	_, replaced, err = cliStore.Create(testEpoch, SessionClientCLI)
	if err != nil {
		t.Fatal(err)
	}
	if len(replaced) != 0 {
		t.Fatalf("cli 登录不得替换旧版（判 web）会话：%v", replaced)
	}
	if session, err := cliStore.Validate(legacyID, testEpoch); err != nil || session == nil {
		t.Fatalf("旧版会话应存活：(%v, %v)", session, err)
	}
}

func TestSessionStoreUnknownClientOnDiskFailsSafeToWeb(t *testing.T) {
	// 磁盘上出现未知 client 取值（损坏或未来版本写入）时读取归一为 web，
	// web 登录即可替换它——不派生第三条互斥通道。
	path := sessionFilePath(tempDir(t))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("建 state 目录失败：%v", err)
	}
	raw := `{
  "version": 1,
  "sessions": [
    {
      "id": "future-client-session-0000000000000000000",
      "client": "tui",
      "createdAt": 1760000000000,
      "lastUsedAt": 1760000000000,
      "pwdEpoch": "` + testEpoch + `"
    }
  ]
}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatalf("写会话文件失败：%v", err)
	}
	store := NewFileSessionStore(path, nil)
	_, replaced, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatal(err)
	}
	if len(replaced) != 1 || replaced[0] != "future-client-session-0000000000000000000" {
		t.Fatalf("未知 client 取值按 web 被替换：%v", replaced)
	}
}

func TestSessionStoreClientFieldOnDiskShape(t *testing.T) {
	dir := tempDir(t)
	path := sessionFilePath(dir)
	store := NewFileSessionStore(path, nil)
	web, _, err := store.Create(testEpoch, SessionClientWeb)
	if err != nil {
		t.Fatal(err)
	}
	cli, _, err := store.Create(testEpoch, SessionClientCLI)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读会话文件失败：%v", err)
	}
	var parsed struct {
		Version  int              `json:"version"`
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("解析会话文件失败：%v", err)
	}
	byID := map[string]map[string]any{}
	for _, session := range parsed.Sessions {
		byID[session["id"].(string)] = session
	}
	// web 会话不写 client 键：与旧版文件逐字节一致。
	webKeys := byID[web.ID]
	if _, has := webKeys["client"]; has {
		t.Errorf("web 会话不得写 client 键（omitempty）：%v", webKeys)
	}
	wantWebKeys := map[string]bool{"id": true, "createdAt": true, "lastUsedAt": true, "pwdEpoch": true}
	if len(webKeys) != len(wantWebKeys) {
		t.Errorf("web 会话键集应为旧版四键：%v", webKeys)
	}
	// cli 会话写 client:"cli"。
	if byID[cli.ID]["client"] != SessionClientCLI {
		t.Errorf("cli 会话应写 client=cli：%v", byID[cli.ID])
	}
}
