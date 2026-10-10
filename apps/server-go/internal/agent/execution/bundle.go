package execution

import (
	"context"
	"io"
	"strings"
	"time"
)

func (e *Executor) prepareBundle(ctx context.Context, identity, image string, labels map[string]string, skill, workspace io.Reader) (string, error) {
	volume := "elysian-agent-" + strings.TrimPrefix(proxyID(), "proxy-")
	if volume == "elysian-agent-" {
		return "", engineError()
	}
	if err := e.call(ctx, "POST", "/volumes/create", map[string]any{"Name": volume, "Driver": "local", "Labels": labels}, nil); err != nil {
		return "", err
	}
	var created struct {
		ID string `json:"Id"`
	}
	body := map[string]any{"Image": image, "User": "65532:65532", "Labels": labels, "NetworkDisabled": true, "HostConfig": map[string]any{"NetworkMode": "none", "ReadonlyRootfs": true, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "Memory": int64(512 << 20), "MemorySwap": int64(512 << 20), "NanoCpus": int64(1000000000), "PidsLimit": 128, "Mounts": []any{map[string]any{"Type": "volume", "Source": volume, "Target": "/bundle", "ReadOnly": false, "VolumeOptions": map[string]bool{"NoCopy": true}}}, "RestartPolicy": map[string]string{"Name": "no"}, "LogConfig": map[string]string{"Type": "none"}}}
	cleanup := func() error {
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if created.ID != "" {
			if err := e.remove(cctx, created.ID, identity); err != nil {
				return err
			}
		}
		return e.removeVolume(cctx, volume, identity)
	}
	if err := e.call(ctx, "POST", "/containers/create", body, &created); err != nil {
		if cleanup() != nil {
			return "", stopError()
		}
		return "", err
	}
	if len(created.ID) != 64 {
		_ = cleanup()
		return "", stopError()
	}
	if err := e.upload(ctx, created.ID, skill, workspace); err != nil {
		if cleanup() != nil {
			return "", stopError()
		}
		return "", err
	}
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.remove(cctx, created.ID, identity); err != nil {
		return "", stopError()
	}
	return volume, nil
}
func (e *Executor) removeVolume(ctx context.Context, name, identity string) error {
	var value struct {
		Name   string
		Labels map[string]string
	}
	if err := e.call(ctx, "GET", "/volumes/"+name, nil, &value); err != nil {
		return stopError()
	}
	if value.Name != name || value.Labels["elysian.agent.execution"] != "true" || value.Labels["elysian.agent.execution.id"] != identity {
		return stopError()
	}
	if err := e.call(ctx, "DELETE", "/volumes/"+name, nil, nil); err != nil {
		return stopError()
	}
	resp, err := e.request(ctx, "GET", "/volumes/"+name, nil, "")
	if err != nil {
		return stopError()
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		return stopError()
	}
	return nil
}
