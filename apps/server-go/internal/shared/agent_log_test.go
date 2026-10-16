package shared

import "testing"

func TestAgentLogPage(t *testing.T) {
	entries := []any{"first", "second", "third"}
	page, err := AgentLogPage(entries, "", 2)
	if err != nil || page["next"] != "2" || page["hasMore"] != true || len(page["entries"].([]any)) != 2 {
		t.Fatalf("first page %#v %v", page, err)
	}
	page, err = AgentLogPage(entries, "2", 2)
	if err != nil || page["next"] != "" || page["hasMore"] != false || len(page["entries"].([]any)) != 1 {
		t.Fatalf("last page %#v %v", page, err)
	}
	for _, cursor := range []string{"-1", "01", "+1", "4", "invalid"} {
		if _, err := AgentLogPage(entries, cursor, 1); err == nil {
			t.Fatalf("accepted cursor %q", cursor)
		}
	}
	for _, limit := range []int{-1, 101} {
		if _, err := AgentLogPage(entries, "", limit); err == nil {
			t.Fatalf("accepted limit %d", limit)
		}
	}
}
