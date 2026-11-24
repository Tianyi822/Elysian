package harness

import (
	"context"
	"encoding/json"
	"regexp"
	"time"

	"elysian/server/internal/agent/jsonvalue"
)

type ApprovalTarget struct {
	Kind  string   `json:"kind"`
	Key   string   `json:"key"`
	Label string   `json:"label"`
	Notes []string `json:"notes"`
}

type approvalResponse struct {
	approval Approval
	target   *ApprovalTarget
}

// MarshalJSON adds display data to the HTTP response without changing the
// serialized approval used by storage, decisions and replay.
func (r approvalResponse) MarshalJSON() ([]byte, error) {
	raw, err := json.Marshal(r.approval)
	if err != nil || r.target == nil {
		return raw, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	value, err := json.Marshal(r.target)
	if err != nil {
		return nil, err
	}
	fields["target"] = value
	return json.Marshal(fields)
}

var approvalContainerID = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (m *Manager) approvalResponses(ctx context.Context, approvals []Approval) []approvalResponse {
	out := make([]approvalResponse, len(approvals))
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var targets = make(map[string]*ApprovalTarget)
	for i, approval := range approvals {
		out[i].approval = approval
		if m.deps.DescribeTarget == nil || ctx.Err() != nil ||
			approval.Kind == "workflow-gate" || (approval.Status != "pending" && approval.Status != "approved") {
			continue
		}
		o := approval.Operation
		c := o.Capability
		if c.Source != "builtin" || c.ReadOnly || c.Metadata.Domain != "docker" ||
			c.Metadata.ResourceType != "docker-container" || c.Metadata.ResourceKeyArgument != "id" {
			continue
		}
		switch c.Name {
		case "docker_container_power", "docker_container_remove", "docker_container_exec", "docker_container_update",
			"docker_container_start", "docker_container_stop", "docker_container_restart":
		default:
			continue
		}
		args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
		if err != nil {
			continue
		}
		id, _ := args["id"].(string)
		if !approvalContainerID.MatchString(id) {
			continue
		}
		target, read := targets[id]
		if !read {
			targets[id] = nil
			description, err := m.deps.DescribeTarget(ctx, id)
			if err != nil || ctx.Err() != nil || description.Kind != "docker-container" || description.Key != id || description.Label == "" {
				continue
			}
			target = &description
			targets[id] = target
		}
		out[i].target = target
	}
	return out
}
