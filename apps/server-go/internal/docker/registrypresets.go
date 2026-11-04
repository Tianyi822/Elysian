package docker

import (
	"context"
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed registry-presets.json
var registryPresetsJSON []byte

type RegistryPreset struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	URL   string `json:"url"`
	Note  string `json:"note,omitempty"`
}

// RegistryPresets 每次返回独立值；Web、mock 与 Agent 共用这一份发行目录。
func RegistryPresets() []RegistryPreset {
	var presets []RegistryPreset
	if err := json.Unmarshal(registryPresetsJSON, &presets); err != nil {
		panic("内置镜像源目录无效")
	}
	return presets
}

func hubMirrorRegistry(registry string) bool {
	if isOfficialImageRegistry(registry) {
		return true
	}
	host, err := parseRegistryInput(registry)
	if err != nil {
		return false
	}
	for _, preset := range RegistryPresets()[1:] {
		if strings.TrimSuffix(strings.ToLower(host), ":443") == strings.TrimPrefix(preset.URL, "https://") {
			return true
		}
	}
	return false
}

func (a *AgentFacade) Registries(ctx context.Context) ([]RegistryPreset, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	return RegistryPresets(), nil
}

func (a *AgentFacade) Probe(ctx context.Context, registry string) (any, error) {
	if err := a.check(ctx); err != nil {
		return nil, err
	}
	result, err := a.service.ProbeRegistry(ctx, registry)
	return result, agentQueryError(ctx, err)
}
