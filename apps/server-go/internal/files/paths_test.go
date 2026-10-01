package files

/*
 * 纯路径判据的行为测试（filesPaths.test.ts 对等）：归一化规则、拒绝项（相对路径、
 * `..`/`.` 段、控制字符、超长）、写禁区双前缀判定与剪枝清单；另覆盖契约判据
 *（isValidFileName/isValidFileMode/normalizeFileSearch/matchesFilePath/
 * isValidHostUserName）。全部纯计算，不碰文件系统。homeDir 统一注入 /root，
 * 锚定容器内形态。
 */

import (
	"strings"
	"testing"
)

const testHome = "/root"

func TestNormalizeServerFilePath(t *testing.T) {
	t.Run("压掉连续斜杠与尾斜杠；根目录归一化为自身", func(t *testing.T) {
		cases := []struct{ input, want string }{
			{"/", "/"},
			{"/var//log/", "/var/log"},
			{"/var/log", "/var/log"},
		}
		for _, c := range cases {
			got, err := normalizeServerFilePath(c.input)
			if err != nil || got != c.want {
				t.Fatalf("normalizeServerFilePath(%q) = (%q, %v)，期望 (%q, nil)", c.input, got, err, c.want)
			}
		}
	})

	t.Run("拒绝相对路径与空串", func(t *testing.T) {
		for _, input := range []string{"", "var/log", "./var", "a"} {
			_, err := normalizeServerFilePath(input)
			if !errIsInvalidRequest(err) {
				t.Fatalf("normalizeServerFilePath(%q) 应为 400 语义，得到 %v", input, err)
			}
			want := "无效的文件路径：" + input
			if errMessage(err) != want {
				t.Fatalf("错误文案 %q，期望 %q", errMessage(err), want)
			}
		}
	})

	t.Run("拒绝 .. 段与 . 段（不宽松压掉，判据层直接拒绝）", func(t *testing.T) {
		for _, input := range []string{"/a/../b", "/var/./log", "/a/b/.."} {
			_, err := normalizeServerFilePath(input)
			want := "无效的文件路径：" + input
			if err == nil || errMessage(err) != want {
				t.Fatalf("normalizeServerFilePath(%q) 期望 %q，得到 %v", input, want, err)
			}
		}
	})

	t.Run("拒绝 NUL 与全部 C0/C1 控制字符（含换行、制表、DEL）", func(t *testing.T) {
		for _, input := range []string{"/a\x00b", "/a\nb", "/a\tb", "/a\x7Fb", "/a\u0085b", "/a\u009Fb"} {
			_, err := normalizeServerFilePath(input)
			if err == nil || !strings.HasPrefix(errMessage(err), "无效的文件路径：") {
				t.Fatalf("normalizeServerFilePath(%q) 应拒绝，得到 %v", input, err)
			}
		}
	})

	t.Run("归一化后超过 PATH_MAX 拒绝；恰好等于上限放行", func(t *testing.T) {
		long := "/" + strings.Repeat("a", filePathMaxLength)
		if _, err := normalizeServerFilePath(long); err == nil {
			t.Fatal("超过上限应拒绝")
		}
		exact := "/" + strings.Repeat("a", filePathMaxLength-1)
		got, err := normalizeServerFilePath(exact)
		if err != nil || got != exact {
			t.Fatalf("恰好等于上限应放行，得到 (%q, %v)", got, err)
		}
	})
}

func TestPathPrimitives(t *testing.T) {
	t.Run("childPathOf 在根目录下不产生双斜杠", func(t *testing.T) {
		if got := childPathOf("/", "etc"); got != "/etc" {
			t.Fatalf("childPathOf(/, etc) = %q", got)
		}
		if got := childPathOf("/etc", "nginx"); got != "/etc/nginx" {
			t.Fatalf("childPathOf(/etc, nginx) = %q", got)
		}
	})

	t.Run("parentDirOf 与 leafNameOf：一级条目的父目录是根", func(t *testing.T) {
		cases := []struct{ path, parent, leaf string }{
			{"/etc", "/", "etc"},
			{"/etc/nginx", "/etc", "nginx"},
			{"/etc/nginx/nginx.conf", "/etc/nginx", "nginx.conf"},
		}
		for _, c := range cases {
			if got := parentDirOf(c.path); got != c.parent {
				t.Fatalf("parentDirOf(%q) = %q，期望 %q", c.path, got, c.parent)
			}
			if got := leafNameOf(c.path); got != c.leaf {
				t.Fatalf("leafNameOf(%q) = %q，期望 %q", c.path, got, c.leaf)
			}
		}
	})
}

func TestMatchPathPrefix(t *testing.T) {
	cases := []struct {
		path    string
		prefix  string
		matches bool
	}{
		{"/root/.Elysian", "/root/.Elysian", true},
		{"/root/.Elysian/data/x", "/root/.Elysian", true},
		{"/root/.Elysian2", "/root/.Elysian", false},
		{"/application", "/app", false},
		{"/app", "/app", true},
	}
	for _, c := range cases {
		_, got := matchPathPrefix(c.path, []string{c.prefix})
		if got != c.matches {
			t.Fatalf("matchPathPrefix(%q, [%q]) = %v，期望 %v", c.path, c.prefix, got, c.matches)
		}
	}
}

func TestForbiddenWritePrefixes(t *testing.T) {
	t.Run("清单同时收录面板资产字符串名与卷挂真身两侧", func(t *testing.T) {
		prefixes := forbiddenWritePrefixes(testHome)
		joined := strings.Join(prefixes, "\n")
		for _, want := range []string{
			"/root/.Elysian", elysianVolumeDir, "/root/.ssh", "/root/.bun", appDir, "/proc", "/sys", "/dev",
		} {
			if !strings.Contains("\n"+joined+"\n", "\n"+want+"\n") {
				t.Fatalf("写禁区清单缺 %q：%v", want, prefixes)
			}
		}
	})

	t.Run("命中与不命中的边界", func(t *testing.T) {
		yes := []string{
			"/root/.Elysian",
			"/root/.Elysian/data/metrics.sqlite",
			"/var/lib/elysian/data",
			"/root/.ssh/authorized_keys",
			"/root/.bun",
			"/app/src/index.ts",
		}
		no := []string{"/root/.Elysian2", "/application", "/etc/nginx/nginx.conf", "/var/log"}
		for _, path := range yes {
			if !isForbiddenWritePath(path, testHome) {
				t.Fatalf("isForbiddenWritePath(%q) 应命中", path)
			}
		}
		for _, path := range no {
			if isForbiddenWritePath(path, testHome) {
				t.Fatalf("isForbiddenWritePath(%q) 不应命中", path)
			}
		}
	})
}

func TestPruneLists(t *testing.T) {
	if strings.Join(virtualFsPrefixes, ",") != "/proc,/sys,/dev" {
		t.Fatalf("虚拟 FS 前缀 %v", virtualFsPrefixes)
	}
	if strings.Join(searchPruneDirNames, ",") != "node_modules" {
		t.Fatalf("剪枝段名 %v", searchPruneDirNames)
	}
	if got := searchExtraPrunePrefixes(testHome); strings.Join(got, ",") != "/root/.bun" {
		t.Fatalf("额外剪枝前缀 %v", got)
	}
}

func TestContractPredicates(t *testing.T) {
	t.Run("isValidFileName：非法名清单与边界", func(t *testing.T) {
		bad := []string{"", " ", "a/b", ".", "..", "fo\no", strings.Repeat("a", 256)}
		for _, name := range bad {
			if isValidFileName(name) {
				t.Fatalf("isValidFileName(%q) 应为 false", name)
			}
		}
		good := []string{"a", " home.html ", strings.Repeat("a", 255), "副本 名", "nginx.conf.tar.gz"}
		for _, name := range good {
			if !isValidFileName(name) {
				t.Fatalf("isValidFileName(%q) 应为 true", name)
			}
		}
	})

	t.Run("isValidFileMode：三位八进制", func(t *testing.T) {
		good := []string{"000", "644", "755", "777"}
		bad := []string{"", "75", "888", "0775", "75a", "75\n"}
		for _, mode := range good {
			if !isValidFileMode(mode) {
				t.Fatalf("isValidFileMode(%q) 应为 true", mode)
			}
		}
		for _, mode := range bad {
			if isValidFileMode(mode) {
				t.Fatalf("isValidFileMode(%q) 应为 false", mode)
			}
		}
	})

	t.Run("normalizeFileSearch：去全部空白（JS \\s 集）+小写", func(t *testing.T) {
		if got := normalizeFileSearch(" SYS\tlog\n "); got != "syslog" {
			t.Fatalf("normalizeFileSearch = %q", got)
		}
		if got := normalizeFileSearch("a\u00A0b"); got != "ab" { // U+00A0
			t.Fatalf("JS 空白集应含 U+00A0，得到 %q", got)
		}
		if got := normalizeFileSearch("\u3000x"); got != "x" { // U+3000
			t.Fatalf("JS 空白集应含 U+3000，得到 %q", got)
		}
		if got := normalizeFileSearch("\uFEFFx"); got != "x" { // U+FEFF
			t.Fatalf("JS 空白集应含 U+FEFF，得到 %q", got)
		}
		if got := normalizeFileSearch("a\u0085b"); got != "a\u0085b" { // U+0085 不在 JS \s 集
			t.Fatalf("U+0085 不应被剔除，得到 %q", got)
		}
	})

	t.Run("matchesFilePath：名称或完整路径任一命中；空关键词视为命中", func(t *testing.T) {
		if !matchesFilePath("", "anything", "/any/path") {
			t.Fatal("空关键词应命中")
		}
		if !matchesFilePath(" SYS log ", "syslog", "/var/log/syslog") {
			t.Fatal("去空白+小写后应命中")
		}
		if !matchesFilePath("nginx", "elysian.conf", "/etc/nginx/conf.d/elysian.conf") {
			t.Fatal("路径命中")
		}
		if matchesFilePath("nginx", "passwd", "/etc/passwd") {
			t.Fatal("不应命中")
		}
	})

	t.Run("isValidHostUserName：小写字母或下划线开头，≤32 字符", func(t *testing.T) {
		good := []string{"root", "deploy", "_a", "a-b_2", strings.Repeat("a", 32)}
		bad := []string{"", "Bad Name", "1abc", "-abc", "abcé", strings.Repeat("a", 33)}
		for _, name := range good {
			if !isValidHostUserName(name) {
				t.Fatalf("isValidHostUserName(%q) 应为 true", name)
			}
		}
		for _, name := range bad {
			if isValidHostUserName(name) {
				t.Fatalf("isValidHostUserName(%q) 应为 false", name)
			}
		}
	})

	t.Run("jsTrim 与 utf16Len 对齐 JS 口径", func(t *testing.T) {
		if got := jsTrim("  home.html \uFEFF"); got != "home.html" {
			t.Fatalf("jsTrim = %q", got)
		}
		if got := utf16Len("日志"); got != 2 {
			t.Fatalf("BMP 内一字符一码元，得到 %d", got)
		}
		if got := utf16Len("😀"); got != 2 {
			t.Fatalf("增补平面一字符两码元，得到 %d", got)
		}
	})
}
