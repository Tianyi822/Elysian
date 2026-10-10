// Package model 提供固定版本模型配置与非流式 Chat Completions 接缝。
package model

import (
	"context"
	"encoding/json"
)

type Capabilities struct {
	Text   bool   `json:"text"`
	Tools  bool   `json:"tools"`
	Source string `json:"source"`
}

// Profile 的修订不可修改；Credential 仅供父进程执行，不进入公开快照。
type Profile struct {
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
}

func (p Profile) Public() Profile {
	p.HasCredential = p.Credential != "" || p.HasCredential
	p.Credential = ""
	return p
}

// Input 中省略 Credential 表示沿用旧值，显式空串表示清除；本地服务允许无凭据。
type Input struct {
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
