package firewall

import "testing"

// parseSockets.test.ts 的对等测试：容器内真实 ss -Hultn 输出 → 监听键集合。

func TestParseSsListening(t *testing.T) {
	listeners := parseSsListening(`udp UNCONN 0      0      127.0.0.11:37622 0.0.0.0:*
tcp LISTEN 0      4096   127.0.0.11:35573 0.0.0.0:*
tcp LISTEN 0      512             *:5173        *:*
tcp LISTEN 0      128          [::]:22             [::]:*`)
	for _, key := range []string{"udp:37622", "tcp:35573", "tcp:5173", "tcp:22"} {
		if !listeners[key] {
			t.Errorf("缺少监听键 %s", key)
		}
	}
	if len(listeners) != 4 {
		t.Errorf("监听键数量 = %d，want 4", len(listeners))
	}
}

func TestParseSsListeningIgnoresNoise(t *testing.T) {
	listeners := parseSsListening(`tcp ESTAB 0      0      10.0.0.2:5432 10.0.0.9:443
garbage line
`)
	if len(listeners) != 0 {
		t.Errorf("非监听状态与无法识别的行应被忽略，得到 %v", listeners)
	}
}
