// Package execution 是父进程持有的受限 Docker 执行器。策略/审批由 harness 决定；
// 本包在派发时再次收紧容器、目录、网络、输入输出与停止确认边界。
package execution

import (
	"context"
	"io"
	"net"
	"time"

	"elysian/server/internal/agent/execution/config"
)

const (
	MaxOutputBytes    = 2 << 20
	MaxWorkspaceBytes = 128 << 20
	MaxWorkspaceFiles = 4096
	MaxSkillBytes     = 64 << 20
	MaxFrameBytes     = 512 << 10
)

type Options struct {
	SocketPath string
	// SupervisorPath 必须是包含 agent-exec-supervisor 入口的 Linux 同二进制。
	SupervisorPath string
	MountRoot      string
	ResolveGrant   func(string, int) (*config.Grant, error)
	// 注入仅供测试；生产使用系统 DNS 和 TCP 拨号。
	LookupIP    func(context.Context, string) ([]net.IPAddr, error)
	DialContext func(context.Context, string, string) (net.Conn, error)
}

type ScriptRequest struct {
	ID               string
	Profile          config.Profile
	Grant            *config.Grant
	ScriptPath       string
	Args             []string
	SkillArchive     io.Reader
	WorkspaceArchive io.Reader
	// 宿主只在 RunScript 成功且数据库 CAS 成功后发布该内容。
	WorkspaceOutput io.Writer
}
type ScriptResult struct {
	ContainerID    string `json:"containerId"`
	ExitCode       int    `json:"exitCode"`
	Stdout         string `json:"stdout"`
	Stderr         string `json:"stderr"`
	WorkspaceBytes int64  `json:"workspaceBytes"`
}
type StdioRequest struct {
	ID             string
	Profile        config.Profile
	Grant          *config.Grant
	Command        []string
	Environment    map[string]string
	ServerID       string
	ServerRevision int
}
type Error struct {
	Status         int    `json:"-"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	OutcomeUnknown bool   `json:"outcomeUnknown,omitempty"`
}

func (e *Error) Error() string { return e.Message }
func problem(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}
func engineError() *Error { return problem(503, "execution-engine", "执行容器通道不可用") }
func protocolError() *Error {
	return problem(502, "execution-protocol", "执行容器协议无效或超过限制")
}
func stopError() *Error {
	return &Error{Status: 503, Code: "execution-stop-unconfirmed", Message: "执行容器停止未确认", OutcomeUnknown: true}
}

type frame struct {
	serverID       string
	serverRevision int
	Kind           string            `json:"kind"`
	ID             string            `json:"id,omitempty"`
	Data           []byte            `json:"data,omitempty"`
	Command        []string          `json:"command,omitempty"`
	Environment    map[string]string `json:"environment,omitempty"`
	Mode           string            `json:"mode,omitempty"`
	Host           string            `json:"host,omitempty"`
	Port           int               `json:"port,omitempty"`
	Scheme         string            `json:"scheme,omitempty"`
	Error          string            `json:"error,omitempty"`
	ExitCode       int               `json:"exitCode,omitempty"`
}

func defaultProfile(image string) config.Profile {
	return config.Profile{Image: image, Runtime: "bash", TimeoutSeconds: 300, CPUMillis: 1000, MemoryBytes: 512 << 20, PIDs: 128, Enabled: true}
}
func timeoutFor(profile config.Profile) time.Duration {
	return time.Duration(profile.TimeoutSeconds) * time.Second
}
