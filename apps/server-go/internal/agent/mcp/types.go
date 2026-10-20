// Package mcp 仅在父进程内持有 MCP 配置、传输会话与凭据。
package mcp

import (
	"context"
	"encoding/json"
	"io"
	"time"

	"elysian/server/internal/agent/execution/config"
)

const ProtocolVersion = "2025-11-25"
const MaxMessageBytes = 512 << 10
const MaxContentBlocks = 128
const MaxCatalogEntries = 512
const MaxCatalogBytes = 4 << 20

type ContainerSpec struct {
	Image           string              `json:"image"`
	Command         []string            `json:"command"`
	GrantID         string              `json:"grantId,omitempty"`
	GrantRevision   int                 `json:"grantRevision,omitempty"`
	RequestedAccess *config.AccessScope `json:"requestedAccess,omitempty"`
	Environment     map[string]string   `json:"-"`
	HasEnvironment  bool                `json:"hasEnvironment"`
}

type Server struct {
	ID            string         `json:"id"`
	Revision      int            `json:"revision"`
	Name          string         `json:"name"`
	Transport     string         `json:"transport"`
	URL           string         `json:"url,omitempty"`
	Stdio         *ContainerSpec `json:"stdio,omitempty"`
	Active        bool           `json:"active"`
	Revoked       bool           `json:"revoked"`
	HasCredential bool           `json:"hasCredential"`
	Credential    string         `json:"-"`
}

func (s Server) Public() Server {
	s.HasCredential = s.HasCredential || s.Credential != ""
	s.Credential = ""
	if s.Stdio != nil {
		copy := *s.Stdio
		copy.Command = append([]string(nil), copy.Command...)
		copy.RequestedAccess = config.CloneAccessScope(copy.RequestedAccess)
		copy.HasEnvironment = copy.HasEnvironment || len(copy.Environment) > 0
		copy.Environment = nil
		s.Stdio = &copy
	}
	return s
}

type ContainerInput struct {
	Image           string              `json:"image"`
	Command         []string            `json:"command"`
	GrantID         string              `json:"grantId,omitempty"`
	GrantRevision   int                 `json:"grantRevision,omitempty"`
	RequestedAccess *config.AccessScope `json:"requestedAccess,omitempty"`
	// nil 沿用旧环境，空对象清除；所有值均按凭据处理。
	Environment *map[string]string `json:"environment,omitempty"`
}

type Input struct {
	Name       string          `json:"name"`
	Transport  string          `json:"transport"`
	URL        string          `json:"url,omitempty"`
	Stdio      *ContainerInput `json:"stdio,omitempty"`
	Active     bool            `json:"active"`
	Revoked    bool            `json:"revoked"`
	Credential *string         `json:"credential,omitempty"`
}

type Tool struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	// 服务器提示不构成权限授予；可信只读必须来自面板本地策略。
	Annotations json.RawMessage `json:"annotations,omitempty"`
}
type Resource struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}
type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}
type Prompt struct {
	Name        string           `json:"name"`
	Title       string           `json:"title,omitempty"`
	Description string           `json:"description,omitempty"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}
type Capabilities struct {
	Tools     bool `json:"tools"`
	Resources bool `json:"resources"`
	Prompts   bool `json:"prompts"`
}
type Catalog struct {
	ProtocolVersion string       `json:"protocolVersion"`
	Capabilities    Capabilities `json:"capabilities"`
	Tools           []Tool       `json:"tools"`
	Resources       []Resource   `json:"resources"`
	Prompts         []Prompt     `json:"prompts"`
	Digest          string       `json:"digest"`
	FetchedAt       time.Time    `json:"fetchedAt"`
}
type Call struct {
	RequestID string          `json:"requestId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	// Schema 来自已固定目录；客户端会在派发前校验。
	InputSchema  json.RawMessage `json:"-"`
	OutputSchema json.RawMessage `json:"-"`
}
type CallResult struct {
	RequestID         string            `json:"requestId"`
	ConnectionID      string            `json:"connectionId"`
	Content           []json.RawMessage `json:"content"`
	StructuredContent json.RawMessage   `json:"structuredContent,omitempty"`
	IsError           bool              `json:"isError"`
}
type ResourceResult struct {
	RequestID    string            `json:"requestId"`
	ConnectionID string            `json:"connectionId"`
	Contents     []json.RawMessage `json:"contents"`
}
type PromptMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}
type PromptResult struct {
	RequestID    string          `json:"requestId"`
	ConnectionID string          `json:"connectionId"`
	Description  string          `json:"description,omitempty"`
	Messages     []PromptMessage `json:"messages"`
}

// Duplex 由宿主注入专属容器管道，不允许此包启动宿主命令。
type Duplex interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Stderr() io.ReadCloser
	Identity() string
	Close(context.Context) error
}
type DuplexFactory interface {
	Open(context.Context, Server) (Duplex, error)
}

// Error 永不包含远端正文、地址、凭据、环境或 stderr。
type Error struct {
	Status         int    `json:"-"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	OutcomeUnknown bool   `json:"outcomeUnknown,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	ConnectionID   string `json:"connectionId,omitempty"`
}

func (e *Error) Error() string { return e.Message }
func problem(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}
func protocolError() *Error {
	return problem(502, "mcp-protocol", "MCP 响应不符合协议或超过限制")
}
func storageError() *Error { return problem(503, "mcp-storage", "MCP 配置读取或持久化失败") }
