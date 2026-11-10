package docker

import (
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/contract"
	domaindocker "elysian/server/internal/docker"
)

func TestDockerSuiteRegisteredInKardiaWithLocalDiscoveryMetadata(t *testing.T) {
	root, registry := install(t, Deps{Views: &fakeViews{}, Agent: &domaindocker.AgentFacade{}}, Config{})
	// 审计清单 24 项 - 已退役 5 项 + power/context_view；退役名仍注册但不再进新聊天白名单。
	if registry.Size() != 26 {
		t.Fatalf("Docker suite=%d", registry.Size())
	}
	for _, name := range []string{"docker_images_list", "docker_containers_list", "docker_container_inspect", "docker_image_inspect"} {
		d, ok := registry.Lookup(name)
		if !ok || len(d.SearchNames) == 0 || !d.Metadata.ReadOnly || d.Metadata.Exposure != "agent" || d.Metadata.Domain != "docker" {
			t.Fatalf("invalid read descriptor: %+v", d)
		}
		if strings.HasSuffix(name, "inspect") {
			if _, err := registry.Execute(root, name, nil); err == nil {
				t.Fatal("inspect accepted missing ID")
			}
			if _, err := registry.Execute(root, name, map[string]any{"id": strings.Repeat("c", 64)}); err == nil {
				t.Fatal("inspect bypassed unavailable authorized facade")
			}
		}
	}
}

func TestDockerSummaryProjectionDoesNotExposeSensitiveFields(t *testing.T) {
	secret := "private-env"
	value := contract.Container{ID: "public-id", Name: "public-name", Env: []contract.EnvPair{{Key: "TOKEN", Value: &secret}}, Command: "private-command", Volumes: []contract.VolumeMount{{HostPath: "/private/mount", ContainerPath: "/private"}}}
	raw, err := json.Marshal(containerSummary(value))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-env", "private-command", "/private/mount", "volumes", "env", "command"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("projection leaked %q: %s", secret, raw)
		}
	}
	if !strings.Contains(string(raw), "public-name") {
		t.Fatal("public identity missing")
	}
}
