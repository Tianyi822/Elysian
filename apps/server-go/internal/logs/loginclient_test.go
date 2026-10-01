package logs

import "testing"

// normalizePeerAddress：IPv4/IPv6 原样、zone id/非地址/空 → 未知（loginClient.test.ts ①）。
func TestNormalizePeerAddress(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"127.0.0.1", "127.0.0.1"},
		{"::1", "::1"},
		{"::ffff:10.0.0.8", "::ffff:10.0.0.8"},
		{"fe80::1%25", unknownAddress},
		{"not-an-ip", unknownAddress},
		{"", unknownAddress},
		{"  10.0.0.8  ", "10.0.0.8"},
		{"256.1.1.1", unknownAddress},
		{"01.2.3.4", unknownAddress},
	}
	for _, tc := range cases {
		if got := NormalizePeerAddress(tc.raw); got != tc.want {
			t.Errorf("NormalizePeerAddress(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// loginLocationOf：回环/私网/链路本地/公网/未知（loginClient.test.ts ②）。
func TestLoginLocationOf(t *testing.T) {
	cases := []struct {
		ip   string
		want string
	}{
		{"127.0.0.1", "本机"},
		{"127.255.255.254", "本机"},
		{"::1", "本机"},
		{"::ffff:127.0.0.1", "本机"},
		{"10.0.0.8", "内网"},
		{"172.16.0.1", "内网"},
		{"172.31.255.255", "内网"},
		{"172.32.0.1", "未知"},
		{"192.168.1.4", "内网"},
		{"169.254.1.1", "内网"},
		{"fc00::1", "内网"},
		{"fd12:3456::1", "内网"},
		{"fe80::1", "内网"},
		{"fe90::1", "未知"}, // TS 只认字面 fe80: 前缀
		{"8.8.8.8", "未知"},
		{"2001:db8::1", "未知"},
		{unknownAddress, "未知"},
	}
	for _, tc := range cases {
		if got := LoginLocationOf(tc.ip); got != tc.want {
			t.Errorf("LoginLocationOf(%q) = %q, want %q", tc.ip, got, tc.want)
		}
	}
}

// PeerAddressFromRequest：RemoteAddr 剥端口（IPv6 方括号）；失败回未知。
func TestPeerAddressFromRequest(t *testing.T) {
	cases := []struct {
		remoteAddr string
		want       string
	}{
		{"127.0.0.1:51736", "127.0.0.1"},
		{"[::1]:51736", "::1"},
		{"10.0.0.8:9999", "10.0.0.8"},
		{"garbage", unknownAddress},
		{"", unknownAddress},
	}
	for _, tc := range cases {
		req := newRequest("POST", "/api/auth/login", "", "")
		req.RemoteAddr = tc.remoteAddr
		if got := PeerAddressFromRequest(req); got != tc.want {
			t.Errorf("PeerAddressFromRequest(%q) = %q, want %q", tc.remoteAddr, got, tc.want)
		}
	}
}
