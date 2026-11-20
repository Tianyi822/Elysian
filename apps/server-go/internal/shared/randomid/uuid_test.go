package randomid

import (
	"regexp"
	"testing"
)

func TestUUIDv4Format(t *testing.T) {
	format := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if id := UUIDv4(); !format.MatchString(id) {
		t.Fatalf("UUID 与持久化和事件标识的格式不符：%q", id)
	}
}
