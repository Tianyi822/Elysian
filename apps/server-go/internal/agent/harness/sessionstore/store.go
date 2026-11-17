// Package sessionstore 定义 Harness 的持久化边界。作用域内只能读取和保存事实，
// 不得调用模型、派发外部操作或等待副本；写入回调不会自动重试。
package sessionstore

import (
	"context"
	"errors"
)

type Watermark int64

type CommitState string

const (
	NotCommitted  CommitState = "not-committed"
	Committed     CommitState = "committed"
	CommitUnknown CommitState = "unknown"
)

// CommitReceipt 的水位只在 Committed 时有效；副本尚未同步不改变提交结果。
type CommitReceipt struct {
	State     CommitState
	Watermark Watermark
}

type SessionStore interface {
	ReadView
	Commands
	// View 在同一次读取中组合多项事实。实现可对暂时中断整次重读一次，
	// 回调只能读取，必须使用传入的上下文和视图；结果在成功后才可发布。
	View(context.Context, string, func(context.Context, ReadView) error) error
	// Update 原子保存回调中的全部事实、检查点与 outbox；回调最多执行一次。
	// 回滚失败和提交回执丢失均返回 CommitUnknown，调用方必须保留关联产物。
	Update(context.Context, string, func(Tx) error) (CommitReceipt, error)
	// ChangeRun 读取并更新一个 Run；终态同时结清会话占用。
	ChangeRun(context.Context, string, string, func(Tx, *Run) error) (Run, error)
	CommittedWatermark(context.Context) (Watermark, error)
	AwaitReplicated(context.Context, Watermark) error
	Health() StorageHealth
	DispatchError() error
	Changes() <-chan struct{}
	// Close 由装配层在 Manager 停止后调用；超时只限制等待，不中止清理。
	Close(context.Context) error
}

type FaultKind string

const (
	ReadUnavailable    FaultKind = "read-unavailable"
	WriteUnavailable   FaultKind = "write-unavailable"
	UnconfirmedCommit  FaultKind = "commit-unknown"
	ReplicaUnavailable FaultKind = "replica-unavailable"
	ReplicaIntegrity   FaultKind = "replica-integrity"
)

var (
	ErrNotFound      = errors.New("持久记录不存在")
	ErrCommitUnknown = errors.New("事务提交结果未确认")
)

// Fault 保留原始原因供诊断和 errors.Is/As 使用；上层只按语义分类裁决。
type Fault struct {
	Kind      FaultKind
	Operation string
	Transient bool
	Cause     error
}

func (e *Fault) Error() string { return e.Cause.Error() }
func (e *Fault) Unwrap() error { return e.Cause }
func (e *Fault) Is(target error) bool {
	return target == ErrCommitUnknown && e.Kind == UnconfirmedCommit
}

func IsTransientRead(err error) bool {
	var fault *Fault
	return errors.As(err, &fault) && fault.Kind == ReadUnavailable && fault.Transient
}

func CommitUnconfirmed(err error) bool { return errors.Is(err, ErrCommitUnknown) }

// Inspector 只检查既有事实；维护与 CLI 装配不启动迁移、恢复或副本 worker。
type Inspector interface {
	PreserveFacts(context.Context, string) (bool, error)
	ActiveRuns(context.Context, string) (int, error)
}
