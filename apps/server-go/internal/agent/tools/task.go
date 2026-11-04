package tools

// TaskReference identifies a durable domain task, never a process-local handle.
type TaskReference struct {
	Domain    string `json:"domain"`
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
}

type Submission struct {
	Value any
	Task  TaskReference
}

type TaskStatus struct {
	State    string
	Terminal bool
	Failed   bool
	Value    any
	Error    string
	Progress *TaskProgress
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
