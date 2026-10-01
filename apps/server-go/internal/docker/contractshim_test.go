package docker

import (
	"strings"
	"testing"
)

// 契约判据域内等价物对等测试（containerFields / imageReference / shellWords /
// containers / engine API 判据锚点）。

func TestIsSensitiveEnvKey(t *testing.T) {
	hits := []string{"DB_PASSWORD", "passwd", "SECRET_VALUE", "api_token", "MY_CREDENTIAL", "ssh_KEY", "KEYSTORE"}
	for _, key := range hits {
		if !isSensitiveEnvKey(key) {
			t.Fatalf("%s 应命中", key)
		}
	}
	misses := []string{"PATH", "HOME", "MODE"}
	for _, key := range misses {
		if isSensitiveEnvKey(key) {
			t.Fatalf("%s 不应命中", key)
		}
	}
}

func TestParseImageReference(t *testing.T) {
	cases := []struct {
		raw  string
		name string
		tag  string
	}{
		{"redis:8-alpine", "redis", "8-alpine"},
		{"NGINX:1.27", "nginx", "1.27"},
		{"redis", "redis", "latest"},
		{"mirror.example:5000/app:v1", "mirror.example:5000/app", "v1"},
		{"a/b:c/d", "a/b:c/d", "latest"}, // 最后冒号后含 /：视为名称
	}
	for _, tc := range cases {
		parsed, err := parseImageReference(tc.raw)
		if err != nil || parsed.name != tc.name || parsed.tag != tc.tag {
			t.Fatalf("%q → %+v %v，want %s:%s", tc.raw, parsed, err, tc.name, tc.tag)
		}
	}
	// 大写统一小写化后合法。
	if parsed, err := parseImageReference("UPPER"); err != nil || parsed.name != "upper" {
		t.Fatalf("UPPER → %+v %v", parsed, err)
	}
	fails := []struct{ raw, message string }{
		{"", "请输入镜像引用，例如 redis:8-alpine"},
		{"a b", "名称仅限小写字母、数字与 : _ . / -，且以字母或数字开头"},
		{"x:bad tag", "标签仅限字母、数字与 _ . -"},
	}
	for _, tc := range fails {
		_, err := parseImageReference(tc.raw)
		if err == nil || err.Error() != tc.message {
			t.Fatalf("%q：%v，want %q", tc.raw, err, tc.message)
		}
	}
}

func TestParseShellWords(t *testing.T) {
	args, err := parseShellWords(`nginx -g "daemon off;" 'single word'`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"nginx", "-g", "daemon off;", "single word"}
	if len(args) != len(want) {
		t.Fatalf("%v", args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("第 %d 词 %q，want %q", i, args[i], want[i])
		}
	}
	// 未闭合引号 / 换行。
	if _, err := parseShellWords("echo 'x"); err == nil || err.Error() != "启动命令含有未闭合的引号" {
		t.Fatalf("单引号：%v", err)
	}
	if _, err := parseShellWords(`echo "x`); err == nil || err.Error() != "启动命令含有未闭合的引号" {
		t.Fatalf("双引号：%v", err)
	}
	if _, err := parseShellWords("echo\nhi"); err == nil || err.Error() != "启动命令不能包含换行" {
		t.Fatalf("换行：%v", err)
	}
	// 双引号转义与反斜杠转义。
	args, err = parseShellWords(`a\"b c\\d`)
	if err != nil {
		t.Fatal(err)
	}
	if args[0] != `a"b` || args[1] != `c\d` {
		t.Fatalf("转义：%v", args)
	}
}

func TestAutoContainerName(t *testing.T) {
	if got := autoContainerName(nil, "library/redis"); got != "library-redis" {
		t.Fatalf("/ → -：%q", got)
	}
	if got := autoContainerName([]string{"redis", "redis-2"}, "redis"); got != "redis-3" {
		t.Fatalf("冲突追加序号：%q", got)
	}
	if got := autoContainerName([]string{"other"}, "redis"); got != "redis" {
		t.Fatalf("不冲突原名：%q", got)
	}
}

func TestCheckEngineAPIVersion(t *testing.T) {
	if !checkEngineAPIVersion("1.41") || !checkEngineAPIVersion("1.44") || !checkEngineAPIVersion("2.0") {
		t.Fatal("≥1.41 应通过")
	}
	if checkEngineAPIVersion("1.40") || checkEngineAPIVersion("1.9") || checkEngineAPIVersion("0.9") {
		t.Fatal("低于 1.41 应拒绝")
	}
	if checkEngineAPIVersion("x.y") || checkEngineAPIVersion("") {
		t.Fatal("非数字按 0 拒")
	}
}

func TestReservedPortsList(t *testing.T) {
	ports := reservedPortsList()
	if len(ports) != 3 || ports[0] != 22 || ports[1] != 48100 || ports[2] != 48101 {
		t.Fatalf("保留端口表：%v", ports)
	}
}

func TestShellQuoteRoundTripInCommand(t *testing.T) {
	// 含空白与引号的 token 加单引号，内部每个单引号转为 引-反斜杠-引-引 四字符序列。
	escaped := "'" + "\\" + "''"
	want := "'" + "echo " + escaped + "hi" + escaped + "'"
	if quoted := shellQuoteToken("echo 'hi'"); quoted != want {
		t.Fatalf("got %q，want %q", quoted, want)
	}
	if shellQuoteToken("plain") != "plain" {
		t.Fatal("无空白不加引号")
	}
}

func TestStripSha256PrefixAndTrim(t *testing.T) {
	if stripSha256Prefix("sha256:abc") != "abc" || stripSha256Prefix("abc") != "abc" {
		t.Fatal("前缀剥离")
	}
	if strings.Count(strings.Repeat("a", 64), "a") != 64 {
		t.Fatal("sanity")
	}
}
