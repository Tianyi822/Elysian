package terminals

import "time"

const (
	TERMINAL_MAX_SESSIONS         = 5
	TERMINAL_IDLE_TIMEOUT         = 30 * time.Minute
	TERMINAL_FRAME_MAX_BYTES      = 8192
	TERMINAL_INPUT_MAX_BYTES      = 32 * 1024
	TERMINAL_DATA_MAX_BYTES       = 32 * 1024
	TERMINAL_CREDIT_BYTES         = 256 * 1024
	TERMINAL_COLS                 = 100
	TERMINAL_ROWS                 = 30
	TERMINAL_VIOLATION_CLOSE_CODE = 1008
	TERMINAL_LIMIT_REASON         = "并发终端会话已达上限（5）"
	TERMINAL_UNAVAILABLE_MESSAGE  = "真实终端仅在 Docker 容器内可用"
)

// The shell owns editing, prompts, history and pagers. Only explicit environment
// entries are passed, so panel credentials never become shell environment.
func buildPtyEnv(homeDir string, extra map[string]string) map[string]string {
	env := map[string]string{
		"HOME": homeDir,
		"PATH": homeDir + "/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"TERM": "xterm-256color",
		"LANG": "C.UTF-8",
	}
	for k, v := range extra {
		env[k] = v
	}
	// 保留本次 shell 的原生内存历史，退出时不向宿主历史文件持久化命令。
	env["HISTFILE"] = "/dev/null"
	return env
}
