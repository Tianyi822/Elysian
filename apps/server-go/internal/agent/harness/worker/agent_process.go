package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"
)

type agentInvocation struct {
	response ModelResponse
	err      error
}

func invokeAgent(ctx context.Context, broker AgentBroker, request frame, done chan<- agentInvocation) {
	result := agentInvocation{}
	defer func() {
		if recover() != nil {
			result.err = errors.New("父进程 Agent 操作发生异常")
		}
		done <- result
	}()
	switch request.Type {
	case "agent/model":
		result.response, result.err = broker.NextModel(ctx)
	case "agent/tool":
		result.err = broker.ExecuteAgent(ctx, request.ResponseID, *request.Index, request.CallID, request.Tool, append(json.RawMessage(nil), request.Args...))
	case "agent/finalize":
		result.err = broker.Finalize(ctx, request.ResponseID)
	}
}

// RunAgent 驱动父进程持有的模型与工具循环。子进程只能消费父侧已确认的响应投影，
// 下一条操作必须与该投影一致；任何完成帧都不能替代父侧 Finalize 的成功事实。
func (p *process) RunAgent(ctx context.Context, runID string, broker AgentBroker) error {
	if ctx == nil || broker == nil || !identifier.MatchString(runID) {
		return errors.New("运行 Agent 必须提供有效上下文、任务编号和父进程调用器")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	p.mu.Lock()
	if p.closing || p.lifetime.Err() != nil {
		p.mu.Unlock()
		return &InterruptedError{Err: errors.New("工作进程已关闭")}
	}
	if p.active {
		p.mu.Unlock()
		return ErrBusy
	}
	p.sequence++
	requestID := "request-" + strconv.FormatUint(p.sequence, 10)
	p.active = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.active = false; p.mu.Unlock() }()
	runCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(p.lifetime, cancel)
	defer stop()
	defer cancel()
	start := p.control("run/start")
	start.RunID, start.RequestID = runID, requestID
	start.Driver, start.DriverVersion = agentDriverName, agentDriverVersion
	if v, ok := broker.(interface{ DriverVersion() int }); ok {
		start.DriverVersion = v.DriverVersion()
	}
	if err := p.send(runCtx, start); err != nil {
		return p.interrupt(fmt.Errorf("提交 Agent 任务失败：%w", err))
	}
	stage, operation, index := "agent/model", 0, 0
	pending, requested, finished := false, false, false
	var current ModelResponse
	seen := responseIDs{responses: map[string]bool{}, calls: map[string]bool{}}
	var failure, cancelErr error
	var grace <-chan time.Time
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	done := make(chan agentInvocation, 1)
	cancelled := runCtx.Done()
	for {
		if finished && !pending {
			if cancelErr != nil {
				return cancelErr
			}
			if err := runCtx.Err(); err != nil {
				return err
			}
			return failure
		}
		select {
		case <-cancelled:
			cancelErr = runCtx.Err()
			cancelled = nil
			timer = time.NewTimer(cancelGrace)
			grace = timer.C
			if !finished {
				f := p.control("run/cancel")
				f.RunID, f.RequestID = runID, requestID
				deadline, end := context.WithTimeout(context.Background(), cancelGrace)
				err := p.send(deadline, f)
				end()
				if err != nil {
					return p.interrupt(errors.Join(cancelErr, err))
				}
			}
		case <-grace:
			return p.interrupt(errors.Join(cancelErr, errors.New("取消后 Agent 工作进程或父侧操作未在 5 秒内收尾")))
		case result := <-done:
			pending = false
			if cancelErr != nil || runCtx.Err() != nil {
				continue
			}
			f := p.control("agent/result")
			completedOperation := operation
			f.RunID, f.RequestID, f.Operation = runID, requestID, &completedOperation
			if result.err == nil && stage == "agent/model" {
				current, result.err = seen.accept(result.response)
				if result.err == nil {
					f.ResponseID, f.ToolCalls, f.Final = current.ID, current.ToolCalls, current.Final
					f.StartIndex = current.StartIndex
					_, result.err = encodeFrame(f)
				}
			}
			if result.err != nil {
				failure = result.err
				f.ResponseID, f.ToolCalls, f.Final = "", nil, false
				f.Error = "父进程 Agent 操作失败"
				if errors.Is(result.err, ErrSuspended) {
					f.Error = "waiting-approval"
				}
			}
			if err := p.send(runCtx, f); err != nil {
				return p.interrupt(fmt.Errorf("提交 Agent 操作结果失败：%w", err))
			}
			if failure == nil {
				switch stage {
				case "agent/model":
					index = current.StartIndex
					if current.Final {
						stage = "agent/finalize"
					} else {
						stage = "agent/tool"
					}
				case "agent/tool":
					index++
					if index == len(current.ToolCalls) {
						stage = "agent/model"
					}
				case "agent/finalize":
					stage = "complete"
				}
				operation++
				requested = false
			}
		case got, ok := <-p.frames:
			if !ok || got.err != nil {
				if got.err == nil {
					got.err = io.EOF
				}
				return p.interrupt(errors.Join(cancelErr, fmt.Errorf("读取 Agent 工作进程消息失败：%w", got.err)))
			}
			f := got.frame
			if err := f.basic(p.generation); err != nil {
				return p.interrupt(err)
			}
			if f.RunID != runID || f.RequestID != requestID || finished {
				return p.interrupt(errors.New("Agent 消息不属于当前运行"))
			}
			if f.Type == "run/finished" {
				valid := f.runOnly() && ((f.Status == "succeeded" && stage == "complete" && failure == nil && !pending) || (f.Status == "waiting-approval" && errors.Is(failure, ErrSuspended) && !pending) || (f.Status == "failed" && failure != nil && !pending && !errors.Is(failure, ErrSuspended)) || (f.Status == "cancelled" && cancelErr != nil))
				if !valid {
					return p.interrupt(errors.New("Agent 结束状态与父侧执行事实不符"))
				}
				finished = true
				continue
			}
			if requested || failure != nil || f.Type != stage || !validAgentRequest(f, operation, current, index) {
				return p.interrupt(errors.New("Agent 操作与已确认模型响应不符或越序"))
			}
			requested = true
			if cancelErr == nil && runCtx.Err() == nil {
				pending = true
				go invokeAgent(runCtx, broker, f, done)
			}
		}
	}
}

func validAgentRequest(f frame, operation int, response ModelResponse, index int) bool {
	if f.Operation == nil || *f.Operation != operation || len(f.Steps) != 0 || len(f.Value) != 0 || f.Error != "" || f.Status != "" || f.Driver != "" || f.DriverVersion != 0 || len(f.ToolCalls) != 0 || f.Final || f.StartIndex != 0 {
		return false
	}
	switch f.Type {
	case "agent/model":
		return f.ResponseID == "" && f.CallID == "" && f.Index == nil && f.Tool == "" && len(f.Args) == 0
	case "agent/tool":
		if index >= len(response.ToolCalls) || f.Index == nil || *f.Index != index || f.ResponseID != response.ID {
			return false
		}
		call := response.ToolCalls[index]
		return f.CallID == call.ID && f.Tool == call.Name && bytes.Equal(f.Args, call.Args)
	case "agent/finalize":
		return response.Final && f.ResponseID == response.ID && f.CallID == "" && f.Index == nil && f.Tool == "" && len(f.Args) == 0
	default:
		return false
	}
}
