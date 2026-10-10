package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var errStopWorker = errors.New("父进程已关闭工作通道")

// Serve 在子进程运行代码登记的驱动；stdin EOF 立即结束，不进入 HTTP 装配。
// 工具等待只等待管道结果，独立读循环持续接收取消和关闭消息。
func Serve(in io.Reader, out io.Writer, errOut io.Writer) error {
	err := serve(in, out)
	if err != nil && errOut != nil {
		message := err.Error()
		if len(message) > 4096 {
			message = message[:4096]
		}
		_, _ = fmt.Fprintln(errOut, message)
	}
	return err
}

func serve(in io.Reader, out io.Writer) error {
	stop := make(chan struct{})
	defer close(stop)
	if closer, ok := in.(io.Closer); ok {
		defer closer.Close()
	}
	messages := make(chan incoming)
	go func() {
		defer close(messages)
		reader := bufio.NewReader(in)
		for {
			f, err := readFrame(reader)
			select {
			case messages <- incoming{frame: f, err: err}:
			case <-stop:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	next := func() (frame, error) {
		got, ok := <-messages
		if !ok || errors.Is(got.err, io.EOF) {
			return frame{}, errStopWorker
		}
		return got.frame, got.err
	}
	hello, err := next()
	if errors.Is(err, errStopWorker) {
		return nil
	}
	if err != nil {
		return err
	}
	if hello.Type != "hello" || !identifier.MatchString(hello.Generation) || hello.Version != protocolVersion || !hello.controlOnly() {
		return errors.New("工作进程握手消息无效")
	}
	base := frame{Version: protocolVersion, Generation: hello.Generation}
	ready := base
	ready.Type = "ready"
	if err := writeFrame(out, ready); err != nil {
		return err
	}
	var completed *frame
	for {
		f, err := next()
		if errors.Is(err, errStopWorker) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := f.basic(base.Generation); err != nil {
			return err
		}
		if f.Type == "shutdown" && f.controlOnly() {
			return nil
		}
		// 完成帧和取消命令可能交叉，迟到取消不得污染下一项任务。
		if f.Type == "run/cancel" && completed != nil && f.RunID == completed.RunID && f.RequestID == completed.RequestID && f.runOnly() && f.Status == "" {
			continue
		}
		if f.Type != "run/start" || !identifier.MatchString(f.RunID) || !identifier.MatchString(f.RequestID) || f.Index != nil || f.Tool != "" || len(f.Args) != 0 || len(f.Value) != 0 || f.Error != "" || f.Status != "" || !f.noAgentFields() {
			return errors.New("工作进程任务开始消息无效")
		}
		driver, ok := registeredDriver(f.Driver, f.DriverVersion)
		agent, agentOK := registeredAgentDriver(f.Driver, f.DriverVersion)
		if !ok && !agentOK {
			return errors.New("任务驱动名称或版本不受支持")
		}
		if agentOK && len(f.Steps) != 0 {
			return errors.New("Agent 驱动不接受预设工具步骤")
		}
		ctx, cancel := context.WithCancel(context.Background())
		if agentOK {
			agentBase := base
			agentBase.RunID, agentBase.RequestID = f.RunID, f.RequestID
			err = agent.Run(ctx, &agentPipeBroker{base: agentBase, next: next, out: out, cancel: cancel})
		} else {
			if err := driver.Validate(f.Steps); err != nil {
				cancel()
				return err
			}
			steps, copyErr := copySteps(f.Steps)
			if copyErr != nil {
				cancel()
				return copyErr
			}
			err = driver.Run(ctx, steps, func(_ context.Context, index int, tool string, args json.RawMessage) (json.RawMessage, error) {
				call := base
				call.Type, call.RunID, call.RequestID, call.Index, call.Tool, call.Args = "tool/call", f.RunID, f.RequestID, &index, tool, args
				if err := writeFrame(out, call); err != nil {
					return nil, err
				}
				result, err := next()
				if err != nil {
					return nil, err
				}
				if err := result.basic(base.Generation); err != nil {
					return nil, err
				}
				if result.Type == "shutdown" && result.controlOnly() {
					return nil, errStopWorker
				}
				if result.RunID != f.RunID || result.RequestID != f.RequestID {
					return nil, errors.New("工作进程消息不属于当前运行")
				}
				if result.Type == "run/cancel" && result.runOnly() && result.Status == "" {
					cancel()
					return nil, ctx.Err()
				}
				if result.Type != "tool/result" || result.Index == nil || *result.Index != index || result.Tool != tool || len(result.Args) != 0 || len(result.Steps) != 0 || result.Status != "" || result.Driver != "" || result.DriverVersion != 0 || !result.noAgentFields() || (len(result.Value) == 0) == (result.Error == "") {
					return nil, errors.New("工作进程工具结果无效或步骤越序")
				}
				if result.Error != "" {
					return nil, &ToolError{Index: index, Tool: tool, Err: errors.New(result.Error)}
				}
				return result.Value, nil
			})
		}
		cancel()
		finished := base
		finished.Type, finished.RunID, finished.RequestID, finished.Status = "run/finished", f.RunID, f.RequestID, "succeeded"
		if err != nil {
			var toolErr *ToolError
			var agentErr *agentCallbackError
			switch {
			case errors.Is(err, ErrSuspended):
				finished.Status = "waiting-approval"
			case errors.Is(err, errStopWorker):
				return nil
			case errors.Is(err, context.Canceled):
				finished.Status = "cancelled"
			case errors.As(err, &toolErr), errors.As(err, &agentErr):
				finished.Status = "failed"
			default:
				return err
			}
		}
		if err := writeFrame(out, finished); err != nil {
			return err
		}
		completed = &finished
	}
}
