// Package model 提供固定版本模型配置与模型协议接缝。
package model

import (
	"context"
	"encoding/json"
	"slices"
)

type Capabilities struct {
	Text             bool     `json:"text"`
	Tools            bool     `json:"tools"`
	Image            bool     `json:"image,omitempty"`
	Video            bool     `json:"video,omitempty"`
	PDF              bool     `json:"pdf,omitempty"`
	StructuredOutput bool     `json:"structuredOutput,omitempty"`
	WebSearch        bool     `json:"webSearch,omitempty"`
	SystemMessages   bool     `json:"systemMessages,omitempty"`
	ReasoningLevels  []string `json:"reasoningLevels,omitempty"`
	Source           string   `json:"source"`
}

func (c Capabilities) clone() Capabilities {
	c.ReasoningLevels = slices.Clone(c.ReasoningLevels)
	return c
}

const ProviderOpenAICompatible = "openai-compatible"
const ProviderDeepSeek = "deepseek"

const FormatChatCompletions = "chat-completions"
const FormatAnthropicMessages = "anthropic-messages"
const FormatResponses = "responses"

// Profile 的修订不可修改；Credential 仅供父进程执行，不进入公开快照。
type Profile struct {
	Provider      string       `json:"provider"`
	APIFormat     string       `json:"apiFormat"`
	ID            string       `json:"id"`
	Revision      int          `json:"revision"`
	Name          string       `json:"name"`
	BaseURL       string       `json:"baseUrl"`
	Model         string       `json:"model"`
	ContextTokens int          `json:"contextTokens"`
	OutputTokens  int          `json:"outputTokens"`
	Capabilities  Capabilities `json:"capabilities"`
	Active        bool         `json:"active"`
	HasCredential bool         `json:"hasCredential"`
	Credential    string       `json:"-"`
	Service       *ServiceRef  `json:"service,omitempty"`
	Removed       bool         `json:"-"`
}

// ServiceRef 固定服务修订与模型自身开关；Active 是两者共同决定的可用状态。
type ServiceRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	Active   bool   `json:"active"`
	Enabled  bool   `json:"enabled"`
}

type ServiceModel struct {
	Profile
	Enabled bool `json:"enabled"`
}

type Service struct {
	ID            string         `json:"id"`
	Revision      int            `json:"revision"`
	Name          string         `json:"name"`
	Provider      string         `json:"provider"`
	APIFormat     string         `json:"apiFormat"`
	BaseURL       string         `json:"baseUrl"`
	Active        bool           `json:"active"`
	HasCredential bool           `json:"hasCredential"`
	Models        []ServiceModel `json:"models"`
}

type ServiceModelInput struct {
	ID            string       `json:"id,omitempty"`
	Name          string       `json:"name"`
	Model         string       `json:"model"`
	ContextTokens int          `json:"contextTokens"`
	OutputTokens  int          `json:"outputTokens"`
	Capabilities  Capabilities `json:"capabilities"`
	Enabled       bool         `json:"enabled"`
}

type ServiceInput struct {
	Name       string              `json:"name"`
	Provider   string              `json:"provider"`
	APIFormat  string              `json:"apiFormat"`
	BaseURL    string              `json:"baseUrl"`
	Active     bool                `json:"active"`
	Credential *string             `json:"credential,omitempty"`
	Models     []ServiceModelInput `json:"models"`
}

func (p Profile) Public() Profile {
	p.Capabilities = p.Capabilities.clone()
	p.HasCredential = p.Credential != "" || p.HasCredential
	p.Credential = ""
	if p.Service != nil {
		ref := *p.Service
		p.Service = &ref
	}
	return p
}

// Input 中省略 Credential 表示沿用旧值，显式空串表示清除；本地服务允许无凭据，携带凭据的明文 HTTP 仅限本机回环地址。
type Input struct {
	Provider      string       `json:"provider"`
	APIFormat     string       `json:"apiFormat"`
	Name          string       `json:"name"`
	BaseURL       string       `json:"baseUrl"`
	Model         string       `json:"model"`
	ContextTokens int          `json:"contextTokens"`
	OutputTokens  int          `json:"outputTokens"`
	Capabilities  Capabilities `json:"capabilities"`
	Active        bool         `json:"active"`
	Credential    *string      `json:"credential,omitempty"`
}

type Message struct {
	Reasoning  string     `json:"reasoning,omitempty"`
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type Request struct {
	ReasoningLevel string
	// OnReasoning 接收供应商显式返回的可展示思考文本增量，不用于派发工具。
	OnReasoning func(string) `json:"-"`
	// OnContent 只用于展示生成中的回答，不能作为已确认消息或工具执行依据。
	OnContent func(string) `json:"-"`
	Messages  []Message
	Tools     []Tool
	MaxTokens int
	// ToolChoice 可为空、auto、none、required，或本次声明的函数名。
	ToolChoice string
}

// Usage 的 nil 表示服务端未报告，尤其不能把未知缓存命中记为零。
type Usage struct {
	PromptTokens     *int `json:"promptTokens,omitempty"`
	CompletionTokens *int `json:"completionTokens,omitempty"`
	TotalTokens      *int `json:"totalTokens,omitempty"`
	CachedTokens     *int `json:"cachedTokens,omitempty"`
}

type Response struct {
	Reasoning    string     `json:"reasoning,omitempty"`
	Content      string     `json:"content"`
	ToolCalls    []ToolCall `json:"toolCalls,omitempty"`
	FinishReason string     `json:"finishReason"`
	Usage        Usage      `json:"usage"`
}

type Client interface {
	Complete(context.Context, Profile, Request) (Response, error)
}

// Error 不包含服务端正文、请求参数、URL 或凭据。
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.cause }

func problem(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}
