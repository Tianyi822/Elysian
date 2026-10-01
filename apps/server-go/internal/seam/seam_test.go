// Package seam 的骨架桩测试：钉住跨域纯函数与桩实现的行为口径。
package seam

import (
	"context"
	"testing"

	"elysian/server/internal/contract"
)

func TestParseSessionCookie(t *testing.T) {
	cases := []struct {
		name    string
		header  string
		wantVal string
		wantOK  bool
	}{
		{"缺失", "", "", false},
		{"无同名段", "other=1; another=2", "", false},
		{"单段", "elysian_session=abc", "abc", true},
		{"多段取最后", "elysian_session=first; other=1; elysian_session=second", "second", true},
		{"空值不算", "elysian_session=", "", false},
		{"多段末段为空不算", "elysian_session=first; elysian_session=", "", false},
		{"带空白归一", "  elysian_session=abc  ", "abc", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseSessionCookie(tc.header)
			if got != tc.wantVal || ok != tc.wantOK {
				t.Errorf("ParseSessionCookie(%q) = (%q, %v)，期望 (%q, %v)",
					tc.header, got, ok, tc.wantVal, tc.wantOK)
			}
		})
	}
}

func TestIsSelfContainer(t *testing.T) {
	cases := []struct {
		name              string
		selfID, inspectID string
		want              bool
	}{
		{"完全一致", "a64hex", "a64hex", true},
		{"self 以 inspect 为前缀", "a64hexsuffix", "a64hex", true},
		{"不一致", "a64hex", "b64hex", false},
		{"self 为空", "", "a64hex", false},
		{"inspect 为空", "a64hex", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsSelfContainer(tc.selfID, tc.inspectID); got != tc.want {
				t.Errorf("IsSelfContainer(%q, %q) = %v，期望 %v", tc.selfID, tc.inspectID, got, tc.want)
			}
		})
	}
}

func TestNoopPortOpener(t *testing.T) {
	got := NoopPortOpener().EnsurePortRule(context.Background(), 3306, "备注")
	if got.State != contract.FirewallPortSyncSkipped {
		t.Errorf("State = %q，期望 skipped", got.State)
	}
	if got.Port != 3306 {
		t.Errorf("Port = %d，期望 3306", got.Port)
	}
	if got.Detail == nil || *got.Detail != contract.FirewallPortSyncDetailSkipped {
		t.Errorf("Detail = %v，期望固定说明 %q", got.Detail, contract.FirewallPortSyncDetailSkipped)
	}
}

func TestNoopTransportFactory(t *testing.T) {
	tr := NoopTransportFactory().New("/var/run/docker.sock")
	if _, err := tr.Request(context.Background(), EngineRequest{Method: "GET", Path: "/version"}); err == nil {
		t.Error("NoopTransport.Request 应当返回错误")
	}
}
