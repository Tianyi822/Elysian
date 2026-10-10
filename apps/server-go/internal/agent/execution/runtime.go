package execution

import "sort"

// Runtime 只回显受管进程身份和生命周期，不包含容器凭据或启动参数。
type Runtime struct {
	ID             string `json:"id"`
	ContainerID    string `json:"containerId"`
	ServerID       string `json:"serverId,omitempty"`
	ServerRevision int    `json:"serverRevision,omitempty"`
	State          string `json:"state"`
}

func (e *Executor) Runtimes() []Runtime {
	e.mu.Lock()
	processes := make([]*Process, 0, len(e.active))
	for _, p := range e.active {
		processes = append(processes, p)
	}
	e.mu.Unlock()
	out := make([]Runtime, 0, len(processes))
	for _, p := range processes {
		p.mu.Lock()
		state := "running"
		if p.finished {
			state = "stopping"
		}
		out = append(out, Runtime{ID: p.id, ContainerID: p.containerID, ServerID: p.serverID, ServerRevision: p.serverRevision, State: state})
		p.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
