// Package worker 提供面板托管的长驻任务子进程；真实工具始终由父进程调用。
package worker

import (
	"bufio"
	"bytes"
	"context"
	"elysian/server/internal/agent/jsonvalue"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

// MaxFrameBytes 是单条 JSONL 帧的字节上限，不含行尾换行。
const MaxFrameBytes = 512 * 1024

const protocolVersion = 1
const cancelGrace = 5 * time.Second
const maxSteps = 256

// Step 是按顺序执行的一条工具调用。
type Step struct {
	Tool string          `json:"tool"`
	Args json.RawMessage `json:"args"`
}

// Invoker 在父进程调用工具；成功返回表示结果已经完成必要的持久化。
type Invoker func(ctx context.Context, index int, tool string, args json.RawMessage) (json.RawMessage, error)

// Process 是一个可顺序处理多次运行的长驻子进程。
type Process interface {
	Run(context.Context, string, []Step, Invoker) error
	Close(context.Context) error
}

// AgentProcess 是动态模型循环的可选能力，不增加既有批处理假件的实现要求。
type AgentProcess interface {
	RunAgent(context.Context, string, AgentBroker) error
}

// AgentToolCall 仅包含父进程已持久化的调用身份与参数，不包含工具结果。
type AgentToolCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// ModelResponse 是模型响应的执行投影。内容与历史始终保留在父进程。
type ModelResponse struct {
	StartIndex int             `json:"startIndex,omitempty"`
	ID         string          `json:"id"`
	ToolCalls  []AgentToolCall `json:"toolCalls,omitempty"`
	Final      bool            `json:"final,omitempty"`
}

// AgentBroker 在父进程执行并持久化模型、工具和整理操作。ExecuteAgent 返回 nil
// 表示结果已落盘，包括业务失败；非 nil 仅用于必须终止本轮的系统或预算错误。
type AgentBroker interface {
	NextModel(context.Context) (ModelResponse, error)
	ExecuteAgent(context.Context, string, int, string, string, json.RawMessage) error
	Finalize(context.Context, string) error
}

// Options 指定子进程；Path 为空时自举当前二进制的 __agent-worker 子命令。
type Options struct {
	Path             string
	Args             []string
	Env              []string
	HandshakeTimeout time.Duration
}

// ToolError 表示真实工具调用失败，子进程仍可接收后续运行。
type ToolError struct {
	Index int
	Tool  string
	Err   error
}

func (e *ToolError) Error() string {
	return fmt.Sprintf("第 %d 步工具 %s 执行失败：%v", e.Index+1, e.Tool, e.Err)
}
func (e *ToolError) Unwrap() error { return e.Err }

// InterruptedError 表示进程退出、协议失效或强制关闭，不能自动重放工具调用。
type InterruptedError struct{ Err error }

func (e *InterruptedError) Error() string {
	return fmt.Sprintf("任务工作进程已中断：%v", e.Err)
}
func (e *InterruptedError) Unwrap() error { return e.Err }

// ErrBusy 表示长驻进程已经有一项活动运行。
var ErrBusy = errors.New("任务工作进程正在运行另一项任务")

type frame struct {
	StartIndex    int             `json:"startIndex,omitempty"`
	Version       int             `json:"version"`
	Generation    string          `json:"generation"`
	Type          string          `json:"type"`
	RunID         string          `json:"runId,omitempty"`
	RequestID     string          `json:"requestId,omitempty"`
	Index         *int            `json:"index,omitempty"`
	Tool          string          `json:"tool,omitempty"`
	Args          json.RawMessage `json:"args,omitempty"`
	Steps         []Step          `json:"steps,omitempty"`
	Value         json.RawMessage `json:"value,omitempty"`
	Error         string          `json:"error,omitempty"`
	Status        string          `json:"status,omitempty"`
	Driver        string          `json:"driver,omitempty"`
	DriverVersion int             `json:"driverVersion,omitempty"`
	Operation     *int            `json:"operation,omitempty"`
	ResponseID    string          `json:"responseId,omitempty"`
	CallID        string          `json:"callId,omitempty"`
	ToolCalls     []AgentToolCall `json:"toolCalls,omitempty"`
	Final         bool            `json:"final,omitempty"`
}

func (f frame) basic(generation string) error {
	if f.Version != protocolVersion || f.Generation != generation {
		return errors.New("工作进程协议版本或激活代不匹配")
	}
	return nil
}

func (f frame) controlOnly() bool {
	return f.RunID == "" && f.RequestID == "" && f.Index == nil && f.Tool == "" && len(f.Args) == 0 && len(f.Steps) == 0 && len(f.Value) == 0 && f.Error == "" && f.Status == "" && f.Driver == "" && f.DriverVersion == 0 && f.noAgentFields()
}

func (f frame) runOnly() bool {
	return f.Index == nil && f.Tool == "" && len(f.Args) == 0 && len(f.Steps) == 0 && len(f.Value) == 0 && f.Error == "" && f.Driver == "" && f.DriverVersion == 0 && f.noAgentFields()
}

func (f frame) noAgentFields() bool {
	return f.Operation == nil && f.ResponseID == "" && f.CallID == "" && len(f.ToolCalls) == 0 && !f.Final && f.StartIndex == 0
}

// ErrSuspended 表示父端已原子保存审批及恢复游标，不是执行失败。
var ErrSuspended = errors.New("运行等待审批")

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var toolName = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

func copySteps(steps []Step) ([]Step, error) {
	if len(steps) > maxSteps {
		return nil, fmt.Errorf("任务步骤不得超过 %d 条", maxSteps)
	}
	out := make([]Step, len(steps))
	for i, step := range steps {
		if !toolName.MatchString(step.Tool) {
			return nil, fmt.Errorf("第 %d 步工具名称无效", i+1)
		}
		args := step.Args
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		args = bytes.TrimSpace(args)
		if len(args) == 0 || args[0] != '{' || !json.Valid(args) {
			return nil, fmt.Errorf("第 %d 步工具参数必须是 JSON 对象", i+1)
		}
		object, err := jsonvalue.Object(args)
		if err != nil {
			return nil, fmt.Errorf("第 %d 步工具参数无效：%w", i+1, err)
		}
		canonical, err := json.Marshal(object)
		if err != nil {
			return nil, fmt.Errorf("第 %d 步工具参数无效：%w", i+1, err)
		}
		out[i] = Step{Tool: step.Tool, Args: canonical}
	}
	return out, nil
}

func encodeFrame(f frame) ([]byte, error) {
	data, err := json.Marshal(f)
	if err != nil {
		return nil, fmt.Errorf("编码工作进程消息失败：%w", err)
	}
	if len(data) > MaxFrameBytes {
		return nil, errors.New("工作进程消息超过 512 KiB")
	}
	return append(data, '\n'), nil
}

func writeFrame(out io.Writer, f frame) error {
	data, err := encodeFrame(f)
	if err != nil {
		return err
	}
	n, err := out.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	return err
}

func readFrame(in *bufio.Reader) (frame, error) {
	var data []byte
	for {
		part, err := in.ReadSlice('\n')
		if len(data)+len(part) > MaxFrameBytes+1 {
			return frame{}, errors.New("工作进程消息超过 512 KiB")
		}
		data = append(data, part...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(data) > 0 {
				return frame{}, errors.New("工作进程消息缺少换行结尾")
			}
			return frame{}, err
		}
		break
	}
	var f frame
	if _, err := jsonvalue.Decode(data); err != nil {
		return f, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&f); err != nil {
		return frame{}, fmt.Errorf("工作进程消息格式无效：%w", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return frame{}, errors.New("一行只能包含一条工作进程消息")
	}
	return f, nil
}
