package terminals

import (
	"time"

	"elysian/server/internal/seam"
)

// 全部常量对齐盘点 §4.1（terminalsService.ts / terminalStream.ts /
// terminalConnection.ts / terminalFrames.ts 与契约 grid.ts 同值）。

// TERMINAL_MAX_SESSIONS 并发会话上限：第 6 条连接在升级后被以 1008 拒绝（不建 PTY）。
const TERMINAL_MAX_SESSIONS = 5

// TERMINAL_IDLE_TIMEOUT 空闲超时：30 分钟无任何客户端帧即 4000 关闭并杀进程；任意
// 客户端帧（含 ping）重置。
const TERMINAL_IDLE_TIMEOUT = 30 * 60 * 1000 * time.Millisecond

// 合帧节流：每 50ms 或累计 4096 字节发送一帧 output。
const (
	TERMINAL_FLUSH_INTERVAL  = 50 * time.Millisecond
	TERMINAL_FLUSH_MAX_BYTES = 4096
)

// TERMINAL_ORDERED_QUEUE_MAX 保序发送链的最大排队深度：超过即以 1008 断开会话。
// 慢消费连接或事件洪水下链条会积累闭包与待发帧，深度上限是发送侧内存有界的兜底。
const TERMINAL_ORDERED_QUEUE_MAX = 256

// 补全上限（seam 常量为唯一权威）：命令表条数截断；文件表超限回 null（客户端退回命令表）。
const (
	TERMINAL_COMPLETION_COMMANDS_MAX = seam.TerminalCompletionCommandsMax
	TERMINAL_COMPLETION_FILES_MAX    = seam.TerminalCompletionFilesMax
)

// TERMINAL_TURN_OUTPUT_BUDGET_BYTES 单命令轮输出预算：超出部分丢弃，字节累计进
// prompt 事件的 droppedBytes。
const TERMINAL_TURN_OUTPUT_BUDGET_BYTES = 256 * 1024

// TERMINAL_PENDING_MAX_CHARS 未成行积压（pending）的硬上限（字符数）：无换行洪流
// 在此结扎丢弃。字符数 ≤ 对应 UTF-8 字节数，用预算字节数作上限不会误杀预算内的行。
const TERMINAL_PENDING_MAX_CHARS = TERMINAL_TURN_OUTPUT_BUDGET_BYTES

// 客户端单帧字节上限与单条 input data 字节上限（UTF-8）。
const (
	TERMINAL_FRAME_MAX_BYTES = 8192
	TERMINAL_INPUT_MAX_BYTES = 4096
)

// TERMINAL_SEND_BUFFER_LIMIT_BYTES 单连接发送缓冲水位上限：底层连接未发送字节
// 超过即 1008 断开（慢消费背压终态）；恰好等于上限不触发。
const TERMINAL_SEND_BUFFER_LIMIT_BYTES = 1024 * 1024

// PTY 固定栅格与制表位间隔（契约 grid.ts 同值；script 管道无 TIOCSWINSZ 通道，
// 不做动态窗口，栅格由启动行 stty 固定）。
const (
	TERMINAL_COLS      = 100
	TERMINAL_ROWS      = 30
	TERMINAL_TAB_WIDTH = 8
)

// TERMINAL_VIOLATION_CLOSE_CODE 协议违规的统一关闭码。
const TERMINAL_VIOLATION_CLOSE_CODE = 1008

// TERMINAL_LIMIT_REASON 并发上限拒绝文案（与盘点 §3.3 逐字一致）。
const TERMINAL_LIMIT_REASON = "并发终端会话已达上限（5）"

// TERMINAL_BACKPRESSURE_REASON 发送水位超限的关闭 reason。
const TERMINAL_BACKPRESSURE_REASON = "终端连接发送缓冲超限"

// TERMINAL_UNAVAILABLE_MESSAGE 容器边界保护：整片 503 的固定文案。
const TERMINAL_UNAVAILABLE_MESSAGE = "真实终端仅在 Docker 容器内可用"

// TERMINAL_STARTUP_LINE 驯化启动行：关回显、定栅格、关历史扩展，随后 printf 输出
// READY 哨兵（原始字节 \x01READY\x02）。printf 参数里是字面转义文本 \x01（与哨兵
// 真实控制字节可区分，启动行回显不会冒充哨兵）。cols/rows 与 TERMINAL_COLS/ROWS
// 同值，由启动行锚定测试钉住。
const TERMINAL_STARTUP_LINE = "stty cols 100 rows 30 -echo; set +H; printf '\\x01READY\\x02\\n'\n"

// HostShellSessionSpec 本机（容器内 host bash / 裸机 VM）终端沿用的 shell 驯化规格。
var HostShellSessionSpec = seam.ShellSessionSpec{
	Env: map[string]string{
		"PS1": "",
		// PROMPT_COMMAND 在每个提示符处流出 PWD 哨兵；参数里的 \x01 是 printf 的
		// 字面转义文本，运行时才产出的真实控制字节。
		"PROMPT_COMMAND": `printf "\x01PWD:%s\x02\n" "$PWD"`,
	},
	StartupLine: TERMINAL_STARTUP_LINE,
}

// buildPtyEnvBase PTY 环境白名单：只透传驯化所需的最小集合，server 进程其余 env
// （含未来可能的凭据）绝不进终端。PATH 是固定串（含 ~/.bun/bin）。分页器一律指向
// cat：会话是行模式、没有全屏能力，less 一类分页器只会停在翻页提示上。
func buildPtyEnvBase(homeDir string) map[string]string {
	return map[string]string{
		"HOME":          homeDir,
		"PATH":          homeDir + "/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"TERM":          "dumb",
		"LANG":          "C.UTF-8",
		"PAGER":         "cat",
		"GIT_PAGER":     "cat",
		"SYSTEMD_PAGER": "cat",
		"MANPAGER":      "cat",
	}
}

// buildPtyEnv 本机会话的完整 spawn env（白名单 + shell 规格），测试与断言锚点。
func buildPtyEnv(homeDir string, specEnv map[string]string) map[string]string {
	env := buildPtyEnvBase(homeDir)
	for k, v := range specEnv {
		env[k] = v
	}
	return env
}
