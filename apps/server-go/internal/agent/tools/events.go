// events.go 定义工具调用外围的事件名与三段瀑布编排。事件名沿用 Cordis 的
// `域/动作` 形态，派发模式全部是 waterfall（只 result 与 change 是 emit）。
package tools

import (
	"fmt"

	"elysian/server/internal/agent/kardia"
)

// 事件名。三段瀑布的语义：
//
//   - EventPreExecute：监听者返回 *Deny 即拒绝；返回 (nil, nil) 表示放行但中断
//     后续监听者（waterfall 的拦截语义）；要放行且继续，必须调用 ev.Next()。
//   - EventExecute：terminal 就是描述符的处理器，监听者可以包裹（调用 ev.Next()
//     后改写结果，用于计时、重试、结果裁剪）。
//   - EventPostExecute：监听者返回 *Outcome 或 Outcome 即整体改判（降级、把失败
//     转成可读结果）；返回其它类型一律失败闭合。
//
// 被拒的调用不进入 execute 与 post-execute，但一定发出 EventResult（审计不丢）。
// 派发一律用不带 thisArg 的 Waterfall：本层不做「每 agent 一份隔离」，所有已登记
// 的监听者都能看到每次调用（ADR-0023 缺口 8）。
var (
	// EventPreExecute 在执行前裁决是否放行。
	EventPreExecute = kardia.StringEvent("tools/pre-execute")
	// EventExecute 包裹处理器本体。
	EventExecute = kardia.StringEvent("tools/execute")
	// EventPostExecute 在执行后改判结果。
	EventPostExecute = kardia.StringEvent("tools/post-execute")
	// EventResult 报告一次调用的最终结果（emit）。
	EventResult = kardia.StringEvent("tools/result")
	// EventChange 报告注册表成员变化（emit）。
	EventChange = kardia.StringEvent("tools/change")
)

// runCall 走完三段瀑布并返回最终结果。site 是调用点 Context（use site），
// 处理器与监听者都在它之上解析服务。
func runCall(site *kardia.Context, descriptor Descriptor, call Call, args Arguments) Outcome {
	decision, err := site.Waterfall(EventPreExecute, func(*kardia.EventCtx) (any, error) {
		return nil, nil
	}, call)
	if err != nil {
		return Outcome{Err: err}
	}
	if decision != nil {
		deny, ok := decision.(*Deny)
		if !ok {
			return Outcome{Err: fmt.Errorf("工具 %q 的 %s 监听者返回了无法识别的裁决：%T", call.Name, EventPreExecute, decision)}
		}
		reason := deny.Reason
		if reason == "" {
			reason = "未说明原因"
		}
		return Outcome{Err: &DeniedError{Name: call.Name, Reason: reason}}
	}

	value, err := site.Waterfall(EventExecute, func(*kardia.EventCtx) (any, error) {
		return descriptor.Handler(site, args)
	}, call)
	outcome := Outcome{Value: value, Err: err}

	revised, err := site.Waterfall(EventPostExecute, func(*kardia.EventCtx) (any, error) {
		return outcome, nil
	}, call, outcome)
	if err != nil {
		return Outcome{Err: err}
	}
	switch replaced := revised.(type) {
	case *Outcome:
		if replaced == nil {
			return Outcome{Err: fmt.Errorf("工具 %q 的 %s 监听者返回了空的改判", call.Name, EventPostExecute)}
		}
		return *replaced
	case Outcome:
		return replaced
	default:
		return Outcome{Err: fmt.Errorf("工具 %q 的 %s 监听者返回了无法识别的改判：%T", call.Name, EventPostExecute, revised)}
	}
}
