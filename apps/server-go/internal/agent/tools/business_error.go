package tools

// BusinessError 只承载工具明确允许公开、且已确认没有未知执行结果的业务失败。
// 原始域错误、凭据与引擎响应不得放进 Message，也不保留为可解包的原因。
type BusinessError struct {
	Code    string
	Message string
	// NotDispatched 由可信内置域明确声明：本次异步任务未被接受，业务操作未执行。
	// 仅输入预检可用；不得从普通错误、超时或缺少回执推断。
	NotDispatched bool
}

func (e *BusinessError) Error() string { return e.Message }

// AsBusinessError 只接受完整错误链都是同一个业务错误的情况。
// Runtime 会用 errors.Join 附加清理错误；额外失败不能被业务错误掩盖。
func AsBusinessError(err error) (*BusinessError, bool) {
	switch e := err.(type) {
	case *BusinessError:
		return e, e != nil && e.Code != "" && e.Message != ""
	case interface{ Unwrap() []error }:
		children := e.Unwrap()
		if len(children) == 1 {
			return AsBusinessError(children[0])
		}
	case interface{ Unwrap() error }:
		return AsBusinessError(e.Unwrap())
	}
	return nil, false
}
