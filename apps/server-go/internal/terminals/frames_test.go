package terminals

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRawControlFrames(t *testing.T) {
	for _, input := range []string{`{"type":"resize","cols":100,"rows":30}`, `{"type":"ack","bytes":32768}`, `{"type":"ping"}`} {
		if _, ok, reason := parseClientFrame([]byte(input)); !ok {
			t.Fatalf("%s: %s", input, reason)
		}
	}
	for _, input := range []string{`{"type":"input","data":"ls"}`, `{"type":"interrupt"}`, `{"type":"resize","cols":0,"rows":30}`, `{"type":"resize","cols":1001,"rows":30}`, `{"type":"resize","cols":3.5,"rows":30}`, `{"type":"ack","bytes":0}`, `{"type":"ack","bytes":262145}`, `null`, `[]`, `not json`, strings.Repeat("x", 8193)} {
		if _, ok, _ := parseClientFrame([]byte(input)); ok {
			t.Fatalf("accepted %s", input)
		}
	}
}
func TestReadyHasNoEmulatedPromptOrCompletion(t *testing.T) {
	encoded, err := json.Marshal(frameReady{Type: "ready", Protocol: 2, Session: frameSession{ID: "id", User: "root", HostLabel: "h"}})
	if err != nil || string(encoded) != `{"type":"ready","protocol":2,"session":{"id":"id","user":"root","hostLabel":"h"}}` {
		t.Fatalf("ready: %s %v", encoded, err)
	}
}
