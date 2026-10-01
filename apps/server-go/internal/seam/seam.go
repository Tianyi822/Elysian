// Package seam 是跨域窄接口与跨域常量的唯一权威（go-plan §4.1）：域与域之间只允许
// 经由本包的类型对话，接口实现方与消费方见各接口注释。骨架阶段全部落地为签名与
// 桩实现；行为语义的逐字契约在各域盘点。
package seam

import (
	"context"
	"encoding/json"
	"io"
	"net/url"
	"strings"
	"time"

	"elysian/server/internal/contract"
)

// ---------- 日志接缝（logs 域实现；terminals/docker/database/websites 与装配层消费） ----------

// OperationRecord 操作日志条目；Category 取值见 OPERATION_LOG_CATEGORIES。
type OperationRecord struct {
	Category   string // security|files|database|terminals|logs|containers|websites|auth
	Action     string
	Target     *string
	Summary    *string
	Result     string // "success" | "failure"
	Method     string // 大写；WS 升级记 "GET"
	Path       string
	HTTPStatus *int // 升级成功后记 nil
}

// Logs 日志服务接缝。Runtime 写运行日志；RecordOperation 写操作日志并落运行日志镜像。
type Logs interface {
	// Runtime 写一条运行日志（level: debug|info|warning|error）。
	Runtime(level, source, message string)
	// RecordOperation 写操作日志 + 运行日志镜像（`操作：<action>（成功|失败）`）；
	// 任何内部失败只进 stderr，绝不影响业务响应。
	RecordOperation(rec OperationRecord)
}

// ---------- 会话接缝（auth 域实现；terminals 消费；app 装配共享实例） ----------

const (
	// SessionCookieName 服务端会话 Cookie 名。
	SessionCookieName = "elysian_session"
	// SessionRevokedCloseCode 会话撤销时的 WS 关闭码。
	SessionRevokedCloseCode = 1008
	// SessionRevokedCloseReason 会话撤销时的 WS 关闭原因（中文，逐字契约）。
	SessionRevokedCloseReason = "面板会话已失效，连接已关闭"
)

// ParseSessionCookie 从 Cookie 头取最后一个 elysian_session 值；空串/缺失回 ("", false)。
// TS 版按最后一个 elysian_session= 段取值，多段以末段为准。
func ParseSessionCookie(cookieHeader string) (string, bool) {
	var last string
	found := false
	for _, part := range strings.Split(cookieHeader, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, value, ok := strings.Cut(part, "=")
		if !ok || name != SessionCookieName {
			continue
		}
		last, found = value, true
	}
	if !found || last == "" {
		return "", false
	}
	return last, true
}

// SessionConnections 会话连接撤销表：三条显式失效路径（登出、改密 pwdEpoch、退出其他
// 会话）触发撤销，终端升级时登记 closer。装配期创建一次，auth 片（触发端）与
// terminals 片（登记端）必须共享同一实例——漏穿只有静默缺断连。
type SessionConnections interface {
	Register(sessionID string, closer func())
	Unregister(sessionID string, closer func())
	// Revoke 关闭该会话全部 closer，可重入。
	Revoke(sessionID string)
	RevokeOthers(keepSessionID string)
	RevokeAll()
}

// ---------- Docker Engine 接缝（docker 域实现；database/websites/platform 消费） ----------

// EngineAPIPrefix 固定版本前缀，不做协商（docker 盘点 §6）。
const EngineAPIPrefix = "/v1.41"

// EngineRequest 一次 Engine API 请求的形状。
type EngineRequest struct {
	Method   string // GET/POST/PUT/DELETE
	Path     string // 不含版本前缀，如 "/containers/json"
	Query    url.Values
	Body     []byte        // JSON；nil 表示无体
	Timeout  time.Duration // <=0 由实现取缺省
	MaxBytes int64         // 响应体上限；<=0 由实现取缺省（4 MiB）
}

// EngineResponse 一次 Engine API 请求的响应。
type EngineResponse struct {
	Status int
	Body   []byte
}

// DockerTransport Engine 传输器（HTTP-over-unix；go-plan §11 D2：不引入 moby client）。
type DockerTransport interface {
	Request(ctx context.Context, req EngineRequest) (EngineResponse, error)
	// Stream 流式请求（events/pull/logs）：原始块回调 onChunk（不做行切分）；ctx 取消即中止。
	Stream(ctx context.Context, req EngineRequest, onChunk func(chunk []byte)) (EngineResponse, error)
}

// DockerTransportFactory 每次调用产出独立传输器（探测不缓存结果、不缓存连接状态）。
type DockerTransportFactory interface {
	New(socketPath string) DockerTransport
}

// DockerPolicy 挂载与端口策略事实（docker 域 Policy() 的返回形状）。
type DockerPolicy struct {
	MountRoot     string
	ReservedPorts []int // [22, 48100, 48101]
}

// DockerViews 镜像与容器视图（docker 域实现；database/websites 消费）。
type DockerViews interface {
	ListImages(ctx context.Context) ([]contract.ContainerImage, error)
	ListContainers(ctx context.Context) ([]contract.Container, error)
	Policy() DockerPolicy
	// SelfContainerID 空串 = 未识别。
	SelfContainerID() string
}

// IsSelfContainer 引擎 inspect 解析后的自容器判定（selfContainer.ts 语义，纯函数）：
// inspectID === selfID 或 selfID 以 inspectID 为前缀；任一侧为空即 false。自我保护
// 必须以解析后的 Id 为准，直接比对原始参数会被容器名绕过。
func IsSelfContainer(selfID, inspectID string) bool {
	if selfID == "" || inspectID == "" {
		return false
	}
	return inspectID == selfID || strings.HasPrefix(selfID, inspectID)
}

// ---------- Caddy 通道接缝（websites 域实现；platform 消费） ----------

// CaddyChannelUnavailableDetail 通道不可用的固定中文说明。
const CaddyChannelUnavailableDetail = "宿主未提供 Caddy 管理通道"

// CaddyChannelError Caddy 通道错误：Unavailable=true 表示连接类失败
// （ENOENT/EACCES/ECONNREFUSED）；Code 带 errno 名；Message 保留原始原因
// （load 非 2xx 时只含状态码不含响应体，防 PEM 泄漏）。
type CaddyChannelError struct {
	Unavailable bool
	Code        string
	Message     string
}

// Error 实现 error。
func (e *CaddyChannelError) Error() string { return e.Message }

// CaddyAdmin 宿主 Caddy admin socket 通道。
type CaddyAdmin interface {
	CurrentConfig(ctx context.Context) (json.RawMessage, *CaddyChannelError)
	Load(ctx context.Context, config []byte) *CaddyChannelError
}

// CaddyAdminFactory 按需产出通道实例（探测用）。
type CaddyAdminFactory interface {
	New(socketPath string) CaddyAdmin
}

// ---------- 终端会话接缝（terminals 域实现；docker 域复用做容器 exec 终端） ----------

const (
	// TerminalCompletionCommandsMax 补全候选命令上限。
	TerminalCompletionCommandsMax = 4096
	// TerminalCompletionFilesMax 补全候选文件上限。
	TerminalCompletionFilesMax = 512
)

// ShellSessionSpec 终端宿主的启动规格。
type ShellSessionSpec struct {
	Env         map[string]string
	StartupLine string
}

// TerminalIdentity 终端身份标识（提示符与目录锚点用）。
type TerminalIdentity struct {
	User      string
	HostLabel string
	HomeDir   string
}

// PtyProcess 一个已打开的终端宿主进程（本机 pty 或容器 exec 劫持流）。
type PtyProcess interface {
	io.Writer // 写 stdin；PTY 写失败由服务层泵吞掉
	// Stdout 输出泵读源（本机 pty master / 容器 exec 劫持流）。
	Stdout() io.Reader
	// Kill 幂等；对已退出进程重复 kill 忽略。
	Kill() error
	// Exited 退出码；容器 exec 流结束后经 inspect 补查再发。
	Exited() <-chan int
}

// TerminalHostDeps 终端宿主依赖注入形状（本机与容器两种实现各自提供）。
type TerminalHostDeps struct {
	// SpawnPty 打开一个终端宿主（本机 script/pty 或容器 exec），READY 哨兵由服务层消费。
	SpawnPty     func(ctx context.Context, spec ShellSessionSpec, identity TerminalIdentity) (PtyProcess, error)
	ListCommands func(ctx context.Context) ([]string, error) // compgen；失败降级空表
	ListDir      func(dir string) ([]string, error)          // readdir 排序
	DisposeShell func(pid string)                            // 可为 nil（本机终端）
	// Prompt 可为 nil → 缺省 `${user}@${hostLabel}:${tilde(cwd)}$ `；docker exec 注入固定 "$ "。
	Prompt func(identity TerminalIdentity, cwd string) string
}

// TerminalsService 终端会话机：并发上限与活跃计数。
type TerminalsService interface {
	// TryOpen 尝试建会话；false = 并发上限（连接层 1008 拒）。
	TryOpen() (handle TerminalSession, ok bool)
	ActiveCount() int
}

// TerminalSession 一个已建立的终端会话句柄。
type TerminalSession interface {
	ID() string
}

// TerminalConnEvents 一次 WS 升级连接的事件处理器（terminals 域实现全部帧校验、
// ready 扣发、合帧节流、单轮预算、保序队列、空闲超时、撤销接线）。
type TerminalConnEvents interface {
	OnOpen(conn WsConn)
	OnMessage(conn WsConn, text []byte)
	OnClose()
}

// TerminalKit 终端会话机工具箱（terminals 域实现；docker 域容器 exec 终端复用）。
type TerminalKit interface {
	// NewService 建一个会话机。shell 驯化规格与会话身份解析由消费方注入（集成期
	// seam 修订：骨架形状缺这两项，容器 exec 终端无法表达「空启动行 + 容器身份」，
	// 已按 gaps 协议由集成阶段收口）：本机终端传 terminals 域的本机规格与身份解析，
	// 容器 exec 终端传空启动行规格与按容器解析的身份。
	NewService(deps TerminalHostDeps, spec ShellSessionSpec, identity func() TerminalIdentity, maxSessions int) TerminalsService
	// NewTotalLimitedService 合计上限包装器：getActive() 返回的跨服务活跃合计
	// ≥ max 时 tryOpen 拒绝（连接层 1008 拒、不建 PTY）。docker 容器终端的
	// 「全部容器合计 5 上限」由此承载——包装器必须由 terminals 域产出，连接胶水
	// 只认本域会话机类型。
	NewTotalLimitedService(inner TerminalsService, getActive func() int, max int) TerminalsService
	// NewConnEvents 构造连接胶水；revocation 可为 nil（docker 容器终端不接线撤销表，现状语义）。
	NewConnEvents(svc TerminalsService, revocation SessionConnections, sessionID string) TerminalConnEvents
}

// ---------- WebSocket 连接形状（middleware 实现 gorilla 封装；terminals/docker/database 共用） ----------

type WsConn interface {
	// SendText 在连接 OPEN 时发送文本帧并返回 true；非 OPEN 静默丢弃返回 false。
	SendText(text string) bool
	// BufferedAmount 返回已提交未写出到网络的应用层字节数（水位判据）。
	BufferedAmount() int64
	Close(code int, reason string)
	// ReadMessage 阻塞读下一帧；由使用方在独立 goroutine 驱动。
	ReadMessage() (messageType int, data []byte, err error)
}

// ---------- 系统账号接缝（security 域实现；files 域消费） ----------

// PasswdRecord getent passwd 的一条记录。
type PasswdRecord struct {
	Name     string
	UID, GID int
	Gecos    string
	Home     string
	Shell    string
}

// SystemAccounts 系统账号通道（getent，NSS 源）。
type SystemAccounts interface {
	// PasswdAll 等价 `getent passwd`（NSS 源，勿改读 /etc/passwd）；仅执行失败返回 error。
	PasswdAll(ctx context.Context) ([]PasswdRecord, error)
	// PasswdByName 等价 `getent passwd <name>`；退出码 2（查无结果）归一为 (nil, nil)。
	PasswdByName(ctx context.Context, name string) (*PasswdRecord, error)
}

// ---------- 防火墙端口开放接缝（firewall 域实现；database/websites 消费） ----------

// PortOpener 幂等补 ufw 放行规则。
type PortOpener interface {
	// EnsurePortRule 幂等补 ufw 放行；永不返回 error，一切结果以 contract.FirewallPortSync 带回。
	EnsurePortRule(ctx context.Context, port int, note string) contract.FirewallPortSync
}
