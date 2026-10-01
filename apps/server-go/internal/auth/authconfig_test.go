package auth

import "testing"

// 豁免判定的小单测（authConfig.test.ts 的 isAuthExemptPath 对等用例）：四条豁免路径
// 精确匹配、尾斜杠先剥单个，近形路径与更深子路径一律不放行。
// 环境开关（ELYSIAN_AUTH_DEV / ELYSIAN_COOKIE_SECURE 严格等于 "1" 才开）的判定住在
// internal/config（strictlyOne），由 config 包的测试覆盖；parseSessionCookie 住在
// internal/seam（ParseSessionCookie），由 seam 包的测试覆盖——两处不在此重复断言。

func TestIsAuthExemptPath(t *testing.T) {
	for _, path := range AuthExemptPaths {
		if !IsAuthExemptPath(path) {
			t.Errorf("IsAuthExemptPath(%q) = false，期望 true", path)
		}
		if !IsAuthExemptPath(path + "/") {
			t.Errorf("IsAuthExemptPath(%q) = false，期望 true（尾斜杠先剥单个）", path+"/")
		}
	}
	// 豁免之外一律不放行：包括近形路径与更深子路径。
	for _, path := range []string{
		"/api/healthx",
		"/api/auth/loginx",
		"/api/auth/login//",
		"/api/auth/logins",
		"/api/platform/memory",
		"/api/platform/dependencies",
		"/api/logs/runtime",
		"/api/auth",
	} {
		if IsAuthExemptPath(path) {
			t.Errorf("IsAuthExemptPath(%q) = true，期望 false", path)
		}
	}
}
