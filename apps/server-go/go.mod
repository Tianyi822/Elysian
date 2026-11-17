module elysian/server

go 1.26.11

// 固定选型（go-plan §固定选型）：不引入其它框架。骨架阶段仅 chi 与 gorilla/websocket
// 被公共层直接引用，其余各域实现者预钉版本；go.mod 为骨架/集成所有，域实现者只读。
// gopkg.in/yaml.v3 为容器镜像构建引入（ADR-0021，纯 Go 单库，仅 Go 侧；TS 契约侧
// 坚持零依赖），依赖与注释由集成侧变更。
// SQLite v1.52.0 修复查询取消后的结果集泄漏；开发与发布统一 Go 1.26.11。
// Charmbracelet 的既有 v1 选型及 CJK/emoji 宽度依赖保持锁定。
require (
	github.com/creack/pty v1.1.23
	github.com/go-chi/chi/v5 v5.1.0
	github.com/go-sql-driver/mysql v1.8.1
	github.com/gorilla/websocket v1.5.3
	github.com/redis/go-redis/v9 v9.7.0
	golang.org/x/crypto v0.36.0
	golang.org/x/net v0.38.0
	gopkg.in/yaml.v3 v3.0.1
	modernc.org/sqlite v1.52.0
)

require (
	github.com/charmbracelet/bubbles v0.21.0
	github.com/charmbracelet/bubbletea v1.3.7
	github.com/charmbracelet/glamour v0.10.0
	github.com/charmbracelet/lipgloss v1.1.1-0.20250404203927-76690c660834
	github.com/charmbracelet/x/ansi v0.10.1
	github.com/disintegration/imaging v1.6.2
	github.com/mattn/go-isatty v0.0.20
	github.com/mattn/go-runewidth v0.0.19
	github.com/muesli/termenv v0.16.0
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2
	golang.org/x/sys v0.42.0
)

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/alecthomas/chroma/v2 v2.20.0 // indirect
	github.com/atotto/clipboard v0.1.4 // indirect
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/aymerick/douceur v0.2.0 // indirect
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/charmbracelet/colorprofile v0.2.3-0.20250311203215-f60798e515dc // indirect
	github.com/charmbracelet/x/cellbuf v0.0.13 // indirect
	github.com/charmbracelet/x/exp/slice v0.0.0-20250327172914-2fdc97757edf // indirect
	github.com/charmbracelet/x/term v0.2.1 // indirect
	github.com/clipperhouse/stringish v0.1.1 // indirect
	github.com/clipperhouse/uax29/v2 v2.5.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/dlclark/regexp2 v1.11.5 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/erikgeiser/coninput v0.0.0-20211004153227-1c3628e74d0f // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/css v1.0.1 // indirect
	github.com/lucasb-eyer/go-colorful v1.3.0 // indirect
	github.com/mattn/go-localereader v0.0.1 // indirect
	github.com/microcosm-cc/bluemonday v1.0.27 // indirect
	github.com/muesli/ansi v0.0.0-20230316100256-276c6243b2f6 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/muesli/reflow v0.3.0 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/sahilm/fuzzy v0.1.1 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	github.com/yuin/goldmark v1.7.13 // indirect
	github.com/yuin/goldmark-emoji v1.0.6 // indirect
	golang.org/x/exp v0.0.0-20250305212735-054e65f0b394 // indirect
	golang.org/x/image v0.23.0 // indirect
	golang.org/x/term v0.31.0 // indirect
	golang.org/x/text v0.25.0 // indirect
	modernc.org/libc v1.72.3 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)
