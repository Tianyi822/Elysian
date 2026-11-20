package shared

import "testing"

func TestGatewayRejectsDomainsAndWrongPorts(t *testing.T) {
	for _, host := range []string{"evil.example:48100", "127.0.0.1:48101", "127.0.0.1:48100@evil.example", "127.0.0.1:48100/path"} {
		if panelIPHost(host, 48100) {
			t.Fatal("非法 Host 被接受：" + host)
		}
	}
	for _, host := range []string{"127.0.0.1:48100", "198.51.100.20:48100", "[2001:db8::1]:48100", "localhost:48100"} {
		if !panelIPHost(host, 48100) {
			t.Fatal("IP Host 被拒绝：" + host)
		}
	}
}
