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
}
