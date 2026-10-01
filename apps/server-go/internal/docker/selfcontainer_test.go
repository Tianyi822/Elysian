package docker

import (
	"strings"
	"testing"
)

// selfContainer 对等测试（selfContainer.test.ts 锚点）。

func fullID(char byte) string { return strings.Repeat(string(char), 64) }

func TestResolveSelfContainerIdCgroupHit(t *testing.T) {
	id := fullID('a')
	text := "0::/docker/" + strings.ToUpper(id) + "/scope"
	if got := resolveSelfContainerId(text, []string{id}, ""); got != id {
		t.Fatalf("cgroup 大小写不敏感命中：%q", got)
	}
}

func TestResolveSelfContainerIdCgroupNotInList(t *testing.T) {
	text := "0::/docker/" + fullID('f') + "/scope"
	if got := resolveSelfContainerId(text, []string{fullID('a')}, ""); got != "" {
		t.Fatalf("不在容器表 → null：%q", got)
	}
}

func TestResolveSelfContainerIdShortIdNoMatch(t *testing.T) {
	short := strings.Repeat("a", 12)
	text := "0::/docker/" + short + "/scope"
	if got := resolveSelfContainerId(text, []string{fullID('a')}, ""); got != "" {
		t.Fatalf("短 id 不匹配：%q", got)
	}
}

func TestResolveSelfContainerIdNoHex(t *testing.T) {
	if got := resolveSelfContainerId("0::/", []string{fullID('a')}, ""); got != "" {
		t.Fatalf("无 hex → null：%q", got)
	}
}

func TestResolveSelfContainerIdHostnameUniqueHit(t *testing.T) {
	id := fullID('b')
	prefix := id[:12]
	if got := resolveSelfContainerId("0::/", []string{id}, prefix); got != id {
		t.Fatalf("hostname 唯一命中：%q", got)
	}
}

func TestResolveSelfContainerIdHostnameMultiHit(t *testing.T) {
	prefix := strings.Repeat("b", 12)
	id1 := prefix + strings.Repeat("1", 52)
	id2 := prefix + strings.Repeat("2", 52)
	if got := resolveSelfContainerId("0::/", []string{id1, id2}, prefix); got != "" {
		t.Fatalf("多命中 → null：%q", got)
	}
}

func TestResolveSelfContainerIdHostnameNotShortHex(t *testing.T) {
	if got := resolveSelfContainerId("0::/", []string{fullID('c')}, "not-a-host"); got != "" {
		t.Fatalf("非 12 位 hex 不启用 hostname 通道：%q", got)
	}
	if got := resolveSelfContainerId("0::/", []string{fullID('c')}, strings.Repeat("A", 12)); got != "" {
		t.Fatalf("大写 hex 不匹配（须 12 位小写）：%q", got)
	}
}

func TestResolveSelfContainerIdCgroupPriority(t *testing.T) {
	cgroupID := fullID('a')
	hostname := fullID('b')[:12]
	ids := []string{cgroupID, fullID('b')}
	text := "0::/docker/" + cgroupID
	if got := resolveSelfContainerId(text, ids, hostname); got != cgroupID {
		t.Fatalf("cgroup 通道优先：%q", got)
	}
}

func TestSelfInspectCheck(t *testing.T) {
	selfID := fullID('a')
	hit := mustDecode(t, `{"Id":"`+selfID+`"}`)
	if !selfInspectCheck(hit, selfID) {
		t.Fatalf("完整 Id 命中")
	}
	short := selfID[:12]
	prefixInspect := mustDecode(t, `{"Id":"`+short+`"}`)
	if !selfInspectCheck(prefixInspect, selfID) {
		t.Fatalf("前缀寻址命中")
	}
	if selfInspectCheck(mustDecode(t, `{"Id":"`+fullID('z')+`"}`), selfID) {
		t.Fatalf("非自身容器")
	}
	if selfInspectCheck(mustDecode(t, `{"Id":"`+fullID('a')+`"}`), "") {
		t.Fatalf("未识别自身（空 selfID）恒 false")
	}
}
