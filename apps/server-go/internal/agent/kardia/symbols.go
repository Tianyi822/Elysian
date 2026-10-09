// symbols.go 对应 TS core/src/utils.ts 的 symbols 表（utils.ts:47-71）与
// string|symbol 双形态事件名。
//
// TS 的 symbols 表在 Go 侧的归宿（方案 2.1 与差异清单第 8 条）：
//   - shadow/caller/receiver → Context 显式原语（Shadow/ShadowSite/DefSite/CtxFor）；
//   - isolate/intercept/filter → ExtendMeta 具名字段；
//   - effect/init/check/config/invoke/extend/tracker/resolveConfig → Service
//     结构体字段与 Initializer/Caller/Extender 接口；
//   - original/metadata/initHooks/checkProto → 装饰器与 Proxy 机制，Go 无对应。
//
// 真正仍作为动态标记存在的仅 SymTracker，按原表导出。
package kardia

import "sync/atomic"

// Symbol 是 JS Symbol 的 Go 等价物：全局唯一、可比较的具名标记，作 map 键。
type Symbol struct {
	name string
	id   uint64
}

var symbolSeq atomic.Uint64

// NewSymbol 创建全局唯一符号（等价 Symbol(name)）。
func NewSymbol(name string) *Symbol {
	return &Symbol{name: name, id: symbolSeq.Add(1)}
}

// String 返回 "Symbol(name)"（与 JS Symbol.prototype.toString 一致）。
func (s *Symbol) String() string {
	if s == nil {
		return "Symbol()"
	}
	return "Symbol(" + s.name + ")"
}

// Name 返回符号的具名部分（测试内省用）。
func (s *Symbol) Name() string {
	if s == nil {
		return ""
	}
	return s.name
}

// SymTracker 预置符号 cordis.tracker（TS 表中真正作动态标记保留的一项）。
var SymTracker = NewSymbol("cordis.tracker")

// EventName 对应 TS 的 string | symbol 事件名，可作 map 键：字符串名与
// 符号名互不相等（同名 Symbol(a) 与字符串 "a" 在 JS 中也不相等）。
type EventName struct {
	str string
	sym *Symbol
}

// StringEvent 构造字符串事件名。
func StringEvent(name string) EventName { return EventName{str: name} }

// SymbolEvent 构造符号事件名。
func SymbolEvent(sym *Symbol) EventName { return EventName{sym: sym} }

// String 返回字符串名或 "Symbol(name)"。
func (n EventName) String() string {
	if n.sym != nil {
		return n.sym.String()
	}
	return n.str
}

// IsZero 报告是否为未设置的事件名。
func (n EventName) IsZero() bool { return n.str == "" && n.sym == nil }
