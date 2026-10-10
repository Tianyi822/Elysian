// Package skills 管理不可变技能包及其持久化导入任务，不执行技能脚本。
package skills

import (
	"context"
	"io"
	"time"
)

const (
	StateQueued      = "queued"
	StateRunning     = "running"
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateCancelled   = "cancelled"
	StateInterrupted = "interrupted"
)

type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }
func problem(status int, code, message string) error {
	return &Error{Status: status, Code: code, Message: message}
}

type Limits struct {
	PackageBytes int64         `json:"packageBytes"`
	ArchiveBytes int64         `json:"archiveBytes"`
	Files        int           `json:"files"`
	Queue        int           `json:"queue"`
	Timeout      time.Duration `json:"-"`
}

func DefaultLimits() Limits {
	return Limits{PackageBytes: 64 << 20, ArchiveBytes: 64 << 20, Files: 2048, Queue: 32, Timeout: 5 * time.Minute}
}

// GitFetcher 只获取公开指定来源；实现必须禁止执行仓库 hooks 与 submodule。
// credential 不可写入参数、目录或日志。返回完整 commit SHA。
type GitFetcher func(ctx context.Context, rawURL, ref, credential, destination string, limits Limits) (string, error)
type Options struct {
	Limits Limits
	Now    func() time.Time
	Git    GitFetcher
}

type Source struct {
	Kind         string `json:"kind"`
	Path         string `json:"path,omitempty"`
	URL          string `json:"url,omitempty"`
	Ref          string `json:"ref,omitempty"`
	Subdirectory string `json:"subdirectory,omitempty"`
	Commit       string `json:"commit,omitempty"`
}
type ImportInput struct {
	RequestID        string `json:"requestId"`
	SkillID          string `json:"skillId,omitempty"`
	ExpectedRevision int    `json:"expectedRevision,omitempty"`
	Source           Source `json:"source"`
	Enabled          bool   `json:"enabled"`
	Credential       string `json:"-"`
}
type Manifest struct {
	Name          string            `json:"name" yaml:"name"`
	Description   string            `json:"description" yaml:"description"`
	License       string            `json:"license,omitempty" yaml:"license,omitempty"`
	Compatibility string            `json:"compatibility,omitempty" yaml:"compatibility,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
	AllowedTools  string            `json:"allowedTools,omitempty" yaml:"allowed-tools,omitempty"`
}
type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}
type Skill struct {
	ID        string   `json:"id"`
	Revision  int      `json:"revision"`
	CreatedAt string   `json:"createdAt"`
	Enabled   bool     `json:"enabled"`
	Source    Source   `json:"source"`
	Manifest  Manifest `json:"manifest"`
	Digest    string   `json:"digest"`
	Bytes     int64    `json:"bytes"`
	Files     []File   `json:"files"`
}
type ImportTask struct {
	ID                string   `json:"id"`
	RequestID         string   `json:"requestId"`
	State             string   `json:"state"`
	Source            Source   `json:"source"`
	CreatedAt         string   `json:"createdAt"`
	StartedAt         string   `json:"startedAt,omitempty"`
	EndedAt           string   `json:"endedAt,omitempty"`
	CancelRequestedAt string   `json:"cancelRequestedAt,omitempty"`
	SkillID           string   `json:"skillId,omitempty"`
	Revision          int      `json:"revision,omitempty"`
	Error             *Failure `json:"error,omitempty"`
}
type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ImportPage struct {
	Items      []ImportTask `json:"items"`
	NextCursor string       `json:"nextCursor"`
	HasMore    bool         `json:"hasMore"`
}

// ImportReader 将 ZIP 输入与 JSON 元数据分开，上传体不进入配置文件。
type ImportReader = io.Reader
