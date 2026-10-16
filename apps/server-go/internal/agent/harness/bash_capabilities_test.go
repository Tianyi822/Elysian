package harness

import (
	"encoding/json"
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
)

func TestBashCapabilityPinsOnlyEnabledBashProfiles(t *testing.T) {
	capability, ok := bashCapability(BashExec, []execconfig.Profile{
		{ID: "python", Enabled: true, Runtime: "python"},
		{ID: "disabled", Enabled: false, Runtime: "bash"},
		{ID: "bash", Enabled: true, Runtime: "bash"},
	}, []execconfig.Grant{{ID: "grant", Enabled: true}}, true)
	if !ok {
		t.Fatal("enabled Bash profile should expose capability")
	}
	if capability.Source != BashSource || capability.Name != BashExec || capability.ReadOnly {
		t.Fatalf("unexpected Bash capability identity: %+v", capability)
	}
	var schema map[string]any
	if err := json.Unmarshal(capability.Parameters, &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema["properties"].(map[string]any)
	profileEnum := properties["profileId"].(map[string]any)["enum"].([]any)
	if len(profileEnum) != 1 || profileEnum[0] != "bash" {
		t.Fatalf("profile enum leaked unsupported profiles: %#v", profileEnum)
	}
}

func TestBashArgumentsRejectTraversalAndUnknownKeys(t *testing.T) {
	capability, ok := bashCapability(BashScript, []execconfig.Profile{{ID: "bash", Enabled: true, Runtime: "bash"}}, nil, true)
	if !ok {
		t.Fatal("Bash script capability should be available")
	}
	for _, raw := range []string{
		`{"path":"../escape","profileId":"bash","argv":[]}`,
		`{"path":"run.sh","profileId":"bash","argv":[],"extra":true}`,
	} {
		if err := (&Extensions{}).validateBashArguments(capability, json.RawMessage(raw)); err == nil {
			t.Fatalf("unsafe Bash arguments accepted: %s", raw)
		}
	}
}

func TestBashPrepareRejectsNonBashProfile(t *testing.T) {
	e := &Extensions{}
	o := Operation{Capability: Capability{Source: BashExec}, ArgumentsJSON: `{"profileId":"python","argv":[]}`}
	_, err := e.prepareBash(nil, CapabilitySnapshot{Profiles: []execconfig.Profile{{ID: "python", Enabled: true, Runtime: "python"}}}, o)
	if err == nil {
		t.Fatal("non-Bash profile accepted")
	}
}
