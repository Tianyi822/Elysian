package tools

// TaskReference identifies a durable domain task, never a process-local handle.
type TaskReference struct {
	Domain    string `json:"domain"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	Target    string `json:"target,omitempty"`
	Digest    string `json:"digest,omitempty"`
}

type Submission struct {
	Value any
	Task  TaskReference
}

type TaskStatus struct {
	Evidence  *ExecutionEvidence
	Outcome   TaskOutcome
	ErrorCode string
	State     string
	Terminal  bool
	Failed    bool
	Value     any
	Error     string
	Progress  *TaskProgress
}

// Outcome is execution evidence, independent of a domain's presentation state.
type TaskOutcome string

const (
	TaskRunning   TaskOutcome = "running"
	TaskSucceeded TaskOutcome = "succeeded"
	TaskFailed    TaskOutcome = "failed"
	TaskUnknown   TaskOutcome = "unknown"
)

func (s TaskStatus) EffectiveOutcome() TaskOutcome {
	switch s.Outcome {
	case TaskRunning, TaskSucceeded, TaskFailed, TaskUnknown:
		return s.Outcome
	case "": // Compatibility for existing internal inspectors, never infer failure from a label alone.
		if s.Terminal {
			if s.Failed {
				return TaskFailed
			}
			return TaskSucceeded
		}
		if s.State == "unknown" || s.State == "failed" || s.State == "interrupted" || s.State == "cancelled" {
			return TaskUnknown
		}
		return TaskRunning
	default:
		return TaskUnknown
	}
}

// TaskReconciliation binds an administrative decision to the immutable acceptance receipt.
type TaskReconciliation struct {
	ID              string        `json:"id"`
	OperationID     string        `json:"operationId"`
	Task            TaskReference `json:"task"`
	ArgumentsDigest string        `json:"argumentsDigest"`
	Decision        string        `json:"decision"`
	Evidence        string        `json:"evidence"`
	Tool            string        `json:"tool"`
	ArgumentsJSON   string        `json:"-"`
}

// TaskProgress 仅用于展示已接受域任务的进度，不构成完成或停止回执。
// 字节比例只表示 LayerID 对应的当前镜像层；缺少分母时不得估算百分比。
type TaskProgress struct {
	State        string   `json:"state"` // running 或 unknown
	Message      string   `json:"message"`
	UpdatedAt    string   `json:"updatedAt,omitempty"`
	LayerID      string   `json:"layerId,omitempty"`
	CurrentBytes *float64 `json:"currentBytes,omitempty"`
	TotalBytes   *float64 `json:"totalBytes,omitempty"`
}
