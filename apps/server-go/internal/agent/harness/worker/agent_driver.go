package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

const agentDriverName = "agent"
const agentDriverVersion = 1

// agentDriver 只决定下一步操作，模型内容、工具结果和记忆均留在父进程。
type agentDriver struct{}

func registeredAgentDriver(name string, version int) (agentDriver, bool) {
	return agentDriver{}, name == agentDriverName && (version == agentDriverVersion || version == 2)
}

func (agentDriver) Run(ctx context.Context, broker AgentBroker) error {
	if ctx == nil || broker == nil {
		return errors.New("Agent 驱动必须提供上下文与父进程调用器")
	}
	seen := responseIDs{responses: map[string]bool{}, calls: map[string]bool{}}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		response, err := broker.NextModel(ctx)
		if err != nil {
			return err
		}
		response, err = seen.accept(response)
		if err != nil {
			return err
		}
		if response.Final {
			if err := ctx.Err(); err != nil {
				return err
			}
			return broker.Finalize(ctx, response.ID)
		}
		for index, call := range response.ToolCalls {
			if index < response.StartIndex {
				continue
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := broker.ExecuteAgent(ctx, response.ID, index, call.ID, call.Name, append(json.RawMessage(nil), call.Args...)); err != nil {
				return err
			}
		}
	}
}

type responseIDs struct {
	responses map[string]bool
	calls     map[string]bool
}

func (seen *responseIDs) accept(response ModelResponse) (ModelResponse, error) {
	if response.StartIndex < 0 || (!response.Final && response.StartIndex >= len(response.ToolCalls)) || (response.Final && response.StartIndex != 0) {
		return ModelResponse{}, errors.New("模型恢复位置无效")
	}
	if !identifier.MatchString(response.ID) || seen.responses[response.ID] {
		return ModelResponse{}, errors.New("模型响应编号无效或重复")
	}
	if response.Final == (len(response.ToolCalls) != 0) {
		return ModelResponse{}, errors.New("模型响应必须提供工具调用或最终结果标记")
	}
	steps := make([]Step, len(response.ToolCalls))
	local := make(map[string]bool, len(steps))
	for index, call := range response.ToolCalls {
		if !identifier.MatchString(call.ID) || seen.calls[call.ID] || local[call.ID] {
			return ModelResponse{}, errors.New("模型工具调用编号无效或重复")
		}
		local[call.ID] = true
		steps[index] = Step{Tool: call.Name, Args: call.Args}
	}
	canonical, err := copySteps(steps)
	if err != nil {
		return ModelResponse{}, err
	}
	out := ModelResponse{ID: response.ID, Final: response.Final, StartIndex: response.StartIndex}
	for index, step := range canonical {
		out.ToolCalls = append(out.ToolCalls, AgentToolCall{ID: response.ToolCalls[index].ID, Name: step.Tool, Args: step.Args})
	}
	seen.responses[out.ID] = true
	for id := range local {
		seen.calls[id] = true
	}
	return out, nil
}

// agentCallbackError 只在子进程标记父侧已拒绝当前操作，不在管道传递错误细节。
type agentCallbackError struct{}

func (*agentCallbackError) Error() string { return "父进程 Agent 操作失败" }

// agentPipeBroker 只有身份和当前操作序号，不持有模型客户端或任务历史。
type agentPipeBroker struct {
	base      frame
	operation int
	next      func() (frame, error)
	out       io.Writer
	cancel    context.CancelFunc
}

func (b *agentPipeBroker) exchange(ctx context.Context, request frame) (frame, error) {
	if err := ctx.Err(); err != nil {
		return frame{}, err
	}
	operation := b.operation
	request.Version, request.Generation = b.base.Version, b.base.Generation
	request.RunID, request.RequestID, request.Operation = b.base.RunID, b.base.RequestID, &operation
	if err := writeFrame(b.out, request); err != nil {
		return frame{}, err
	}
	result, err := b.next()
	if err != nil {
		return frame{}, err
	}
	if err := result.basic(b.base.Generation); err != nil {
		return frame{}, err
	}
	if result.Type == "shutdown" && result.controlOnly() {
		return frame{}, errStopWorker
	}
	if result.RunID != b.base.RunID || result.RequestID != b.base.RequestID {
		return frame{}, errors.New("Agent 消息不属于当前运行")
	}
	if result.Type == "run/cancel" && result.runOnly() && result.Status == "" {
		b.cancel()
		return frame{}, context.Canceled
	}
	if result.Type != "agent/result" || result.Operation == nil || *result.Operation != operation || result.Index != nil || result.Tool != "" || len(result.Args) != 0 || len(result.Steps) != 0 || len(result.Value) != 0 || result.Status != "" || result.Driver != "" || result.DriverVersion != 0 || result.CallID != "" {
		return frame{}, errors.New("Agent 操作结果无效或越序")
	}
	if result.Error != "" {
		if result.ResponseID != "" || len(result.ToolCalls) != 0 || result.Final || result.StartIndex != 0 {
			return frame{}, errors.New("Agent 错误结果包含执行指令")
		}
		if result.Error == "waiting-approval" {
			return frame{}, ErrSuspended
		}
		return frame{}, &agentCallbackError{}
	}
	if request.Type != "agent/model" && (result.ResponseID != "" || len(result.ToolCalls) != 0 || result.Final || result.StartIndex != 0) {
		return frame{}, errors.New("Agent 确认消息包含多余执行指令")
	}
	b.operation++
	return result, nil
}

func (b *agentPipeBroker) NextModel(ctx context.Context) (ModelResponse, error) {
	f, err := b.exchange(ctx, frame{Type: "agent/model"})
	return ModelResponse{ID: f.ResponseID, ToolCalls: f.ToolCalls, Final: f.Final, StartIndex: f.StartIndex}, err
}

func (b *agentPipeBroker) ExecuteAgent(ctx context.Context, responseID string, index int, callID, name string, args json.RawMessage) error {
	_, err := b.exchange(ctx, frame{Type: "agent/tool", ResponseID: responseID, Index: &index, CallID: callID, Tool: name, Args: args})
	return err
}

func (b *agentPipeBroker) Finalize(ctx context.Context, responseID string) error {
	_, err := b.exchange(ctx, frame{Type: "agent/finalize", ResponseID: responseID})
	return err
}
