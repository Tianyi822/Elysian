// Package workspace 保存 Task 独立的不可变工作区版本，并提供 TAR copy-in/out。
// 当前版本指针属于宿主数据库；Prepare 操作只发布新版本，不能代替数据库 CAS。
package workspace

import "fmt"

const (
	DefaultTaskBytes   int64 = 128 << 20
	DefaultGlobalBytes int64 = 2 << 30
	DefaultTaskFiles         = 4096
)

// Limits 限制每个版本的展开内容和全部已保存归档的实际总字节数。
// 零值使用默认值；调用方可以下调但不能扩大上限。
type Limits struct {
	TaskBytes   int64
	GlobalBytes int64
	TaskFiles   int
}

type Options struct{ Limits Limits }

type Version struct {
	TaskID       string `json:"taskId"`
	Revision     int    `json:"revision"`
	BaseRevision int    `json:"baseRevision"`
	Bytes        int64  `json:"bytes"`
	FileCount    int    `json:"fileCount"`
	// Digest 是按路径排序后的路径、长度和内容 SHA-256 组成的清单摘要。
	Digest string `json:"digest"`
}

type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}

type Snapshot struct {
	Version
	Files []File `json:"files"`
}

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

func storageError(cause error) *Error {
	return &Error{Status: 500, Code: "workspace_storage_failed", Message: "工作区存储操作失败", cause: cause}
}

func quotaError(message string) *Error { return problem(413, "workspace_quota_exceeded", message) }

func normalizeLimits(l Limits) (Limits, error) {
	if l.TaskBytes == 0 {
		l.TaskBytes = DefaultTaskBytes
	}
	if l.GlobalBytes == 0 {
		l.GlobalBytes = DefaultGlobalBytes
	}
	if l.TaskFiles == 0 {
		l.TaskFiles = DefaultTaskFiles
	}
	if l.TaskBytes < 1 || l.TaskBytes > DefaultTaskBytes || l.GlobalBytes < 1 || l.GlobalBytes > DefaultGlobalBytes || l.TaskFiles < 1 || l.TaskFiles > DefaultTaskFiles {
		return Limits{}, problem(400, "workspace_invalid_limits", fmt.Sprintf("工作区限额必须为正数，且不超过默认上限 %d 字节、%d 字节与 %d 个文件", DefaultTaskBytes, DefaultGlobalBytes, DefaultTaskFiles))
	}
	return l, nil
}
