package docker

import (
	"errors"
	"testing"
)

// registryPolicy 对等测试（registryPolicy.test.ts 锚点）。

func resolvePublic(hostname string) ([]string, error) {
	return []string{"93.184.216.34"}, nil
}

func resolveTo(addresses ...string) func(string) ([]string, error) {
	return func(string) ([]string, error) { return addresses, nil }
}

func TestParseRegistryInput(t *testing.T) {
	cases := []struct {
		raw     string
		want    string
		wantErr string
	}{
		{"mirror.example.com", "mirror.example.com", ""},
		{"https://mirror.example.com", "mirror.example.com", ""},
		{"https://mirror.example.com/", "mirror.example.com", ""},
		{"mirror.example.com:5000", "mirror.example.com:5000", ""},
		{"http://mirror.example.com", "", httpNotAllowed},
		{"  ", "", disallowedHost},
		{"https://", "", disallowedHost},
		{"1.2.3.4", "", disallowedHost},
		{"::1", "", disallowedHost},
		{"localhost", "", disallowedHost},
		{"localhost:5000", "", disallowedHost},
		{"singlelabel", "", disallowedHost},
		{"mirror.example.com/path", "", disallowedHost},
		{"mirror.example.com?q=1", "", disallowedHost},
		{"mirror.example.com#f", "", disallowedHost},
		{"mirror.example.com@u", "", disallowedHost},
		{"mirror.example.com\\x", "", disallowedHost},
		{"mirror.local", "", disallowedHost},
		{"mirror.internal", "", disallowedHost},
		{"mirror.lan", "", disallowedHost},
		{"mirror.home.arpa", "", disallowedHost},
		{"-bad.example.com", "", disallowedHost},
		{"bad-.example.com", "", disallowedHost},
		{"mirror.example.com:0", "", disallowedHost},
		{"mirror.example.com:65536", "", disallowedHost},
		{"mirror.example.com:99999", "", disallowedHost},
	}
	for _, tc := range cases {
		got, err := parseRegistryInput(tc.raw)
		if tc.wantErr != "" {
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("%q：got %v，want err %q", tc.raw, err, tc.wantErr)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q：%v", tc.raw, err)
		}
		if got != tc.want {
			t.Fatalf("%q → %q，want %q", tc.raw, got, tc.want)
		}
	}
}

func TestValidateRegistryTargetPrivateRanges(t *testing.T) {
	privates := []string{
		"0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1",
		"172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.1.1",
		"198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1",
		"::1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd00::1", "ff02::1",
	}
	for _, address := range privates {
		if isPublicAddress(address) {
			t.Fatalf("%s 应判定私网", address)
		}
		_, err := validateRegistryTarget("mirror.example.com", resolveTo(address))
		if err == nil || err.Error() != resolvePublicError {
			t.Fatalf("解析到 %s 应报 %q：%v", address, resolvePublicError, err)
		}
	}
}

func TestValidateRegistryTargetPublic(t *testing.T) {
	publics := []string{"93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"}
	for _, address := range publics {
		if !isPublicAddress(address) {
			t.Fatalf("%s 应判定公网", address)
		}
	}
	target, err := validateRegistryTarget("mirror.example.com:5000", resolveTo("93.184.216.34"))
	if err != nil {
		t.Fatal(err)
	}
	if target.host != "mirror.example.com:5000" || len(target.addresses) != 1 {
		t.Fatalf("返回 host 与 addresses：%+v", target)
	}
}

func TestValidateRegistryTargetResolveFailures(t *testing.T) {
	failing := func(string) ([]string, error) { return nil, errors.New("dns boom") }
	_, err := validateRegistryTarget("mirror.example.com", failing)
	if err == nil || err.Error() != resolvePublicError {
		t.Fatalf("解析失败同文案：%v", err)
	}
	_, err = validateRegistryTarget("mirror.example.com", resolveTo())
	if err == nil || err.Error() != resolvePublicError {
		t.Fatalf("空地址同文案：%v", err)
	}
}

func TestIsPublicAddressNonIP(t *testing.T) {
	if isPublicAddress("example.com") {
		t.Fatalf("非 IP 一律非公网")
	}
}
