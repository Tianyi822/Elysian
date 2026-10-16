package database

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

func TestAgentDatabaseControlChecksContainerImageAndVolumeIdentity(t *testing.T) {
	row := databaseRecord{ContainerID: testContainerID, VolumeName: "elysian-db-00000000-0000-0000-0000-000000000000", Engine: engineMySQL, VersionTag: "8.4", Source: sourceManaged}
	running, badVolume := true, false
	posts := 0
	transport := &scriptedTransport{responder: func(req seam.EngineRequest) seam.EngineResponse {
		if req.Method == "POST" {
			posts++
			running = false
			return seam.EngineResponse{Status: 204}
		}
		if strings.Contains(req.Path, "/volumes/") {
			labels := map[string]string{"elysian.database": "true", "elysian.database.engine": row.Engine, "elysian.database.version": row.VersionTag}
			if badVolume {
				labels["elysian.database.version"] = "wrong"
			}
			body, _ := json.Marshal(map[string]any{"Labels": labels})
			return seam.EngineResponse{Status: 200, Body: body}
		}
		body := baseInspectBody()
		body["State"] = map[string]any{"Running": running}
		obj(body["Config"])["Labels"] = map[string]string{"elysian.managed": "true", "elysian.database": "true", "elysian.database.engine": row.Engine, "elysian.database.version": row.VersionTag, "elysian.database.volume": row.VolumeName}
		raw, _ := json.Marshal(body)
		return seam.EngineResponse{Status: 200, Body: raw}
	}}
	d := newDockerAPI(transport, func(context.Context) ([]contract.ContainerImage, error) { return testImageList(), nil })
	badVolume = true
	if err := d.agentControl(context.Background(), row, "stop", ""); err == nil {
		t.Fatal("mismatched volume identity accepted")
	}
	if posts != 0 {
		t.Fatal("unverified control reached engine")
	}
	badVolume = false
	if err := d.agentControl(context.Background(), row, "stop", testContainerID); err == nil {
		t.Fatal("panel self container accepted")
	}
	if err := d.agentControl(context.Background(), row, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if posts != 1 || running {
		t.Fatal("control state was not confirmed")
	}
}
