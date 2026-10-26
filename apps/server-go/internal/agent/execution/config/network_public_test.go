package config

import (
	"net/netip"
	"testing"
)

func TestPublicNetworkPolicyPreservesPrivateGrantBoundary(t *testing.T) {
	for _, raw := range []string{"8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"} {
		if err := CheckPublicNetworkAddress(netip.MustParseAddr(raw)); err != nil {
			t.Errorf("公网 %s 被拒绝: %v", raw, err)
		}
	}
	for _, raw := range []string{"10.1.2.3", "fc00::1", "127.0.0.1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "198.18.0.1", "192.0.2.1", "::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "64:ff9b::7f00:1", "fe80::1%lo0", "fec0::1", "::192.168.0.1", "100::1"} {
		if err := CheckPublicNetworkAddress(netip.MustParseAddr(raw)); err == nil {
			t.Errorf("禁止地址 %s 被接受", raw)
		}
	}
	if CheckPublicNetworkAddress(netip.Addr{}) == nil {
		t.Fatal("无效地址被接受")
	}
	endpoint := NetworkEndpoint{Scheme: "https", Host: "internal.example.com", Port: 443}
	grant := Grant{Enabled: true, Network: []NetworkEndpoint{endpoint}, PrivateCIDRs: []string{"10.1.0.0/16"}}
	addr := netip.MustParseAddr("10.1.2.3")
	if err := CheckNetworkAddress(grant, endpoint, addr); err != nil {
		t.Fatalf("原私网授权失效: %v", err)
	}
	if CheckPublicNetworkAddress(addr) == nil {
		t.Fatal("公网读取继承了执行器的私网授权")
	}
}
