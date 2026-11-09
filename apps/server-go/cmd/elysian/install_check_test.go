package main

import "testing"

func TestInstallCheckPhaseIsExplicitAndDefaultsToFullCheck(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want bool
		fail bool
	}{
		{nil, false, false},
		{[]string{"--before-platform-dependencies"}, true, false},
		{[]string{"--skip-docker"}, false, true},
		{[]string{"--before-platform-dependencies", "extra"}, false, true},
	} {
		got, err := installCheckBeforeDependencies(tc.args)
		if got != tc.want || (err != nil) != tc.fail {
			t.Fatalf("安装预检阶段解析错误：%v -> %t, %v", tc.args, got, err)
		}
	}
}
