package auth

import (
	"regexp"

	"elysian/server/internal/shared"
)

var panelUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{3,32}$`)

// ValidatePanelUsername 校验可修改的单管理员登录名，保留开发账号命名空间。
func ValidatePanelUsername(username, current string) error {
	if !panelUsernamePattern.MatchString(username) {
		return shared.InvalidRequest("用户名须为 3–32 位英文字母、数字、下划线或短横线")
	}
	if username == DevAccountUsername {
		return shared.InvalidRequest("不能使用开发保留用户名 dev")
	}
	if username == current {
		return shared.InvalidRequest("新用户名不能与当前用户名相同")
	}
	return nil
}

// sessionUsername 为旧会话补齐单管理员身份；新会话始终记录实际验证的登录名。
func sessionUsername(session *PanelSession, credentials *PanelCredentials, dev bool) string {
	if session != nil && session.Username != "" {
		return session.Username
	}
	if credentials != nil {
		return credentials.Username
	}
	if dev {
		return DevAccountUsername
	}
	return PanelUsername
}
