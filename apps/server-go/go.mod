module elysian/server

go 1.23

// 固定选型（go-plan §固定选型）：不引入其它框架。骨架阶段仅 chi 与 gorilla/websocket
// 被公共层直接引用，其余五项为各域实现者预钉版本；go.mod 为骨架/集成所有，域实现者只读。
require (
	github.com/creack/pty v1.1.23
	github.com/go-chi/chi/v5 v5.1.0
	github.com/go-sql-driver/mysql v1.8.1
	github.com/gorilla/websocket v1.5.3
	github.com/redis/go-redis/v9 v9.7.0
	golang.org/x/crypto v0.27.0
	modernc.org/sqlite v1.33.1
)
