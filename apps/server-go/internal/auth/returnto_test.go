package auth

import (
	"strings"
	"testing"
)

// 回跳裁决测试（returnTo.test.ts 全部用例原样移植）：只有 origin 精确落在名单里的
// 绝对 http/https 地址可用，且 host 必须仍在回环名单内。通过时回的是 WHATWG 归一化
// href——浏览器所见即裁决所判。

var returnToAllowed = []string{"http://127.0.0.1:5173", "http://127.0.0.1:48100"}

func TestAdjudicateReturnToHitKeepsPathQueryHash(t *testing.T) {
	got := AdjudicateReturnTo("http://127.0.0.1:5173/projects/42?page=2#top", returnToAllowed)
	if got == nil || *got != "http://127.0.0.1:5173/projects/42?page=2#top" {
		t.Errorf("命中名单时回规范化 href，得 %v", got)
	}
}

func TestAdjudicateReturnToTrimAndCaseNormalization(t *testing.T) {
	for _, raw := range []string{"  http://127.0.0.1:5173/x  ", "HTTP://127.0.0.1:5173/x"} {
		got := AdjudicateReturnTo(raw, returnToAllowed)
		if got == nil || *got != "http://127.0.0.1:5173/x" {
			t.Errorf("%q 应归一命中，得 %v", raw, got)
		}
	}
}

func TestAdjudicateReturnToEmptyAllowListAlwaysNull(t *testing.T) {
	if got := AdjudicateReturnTo("http://127.0.0.1:5173/x", nil); got != nil {
		t.Errorf("空名单恒 null，得 %v", *got)
	}
}

func TestAdjudicateReturnToBlankNull(t *testing.T) {
	for _, raw := range []string{"", "   ", "\t\n"} {
		if got := AdjudicateReturnTo(raw, returnToAllowed); got != nil {
			t.Errorf("%q 应回 nil，得 %v", raw, *got)
		}
	}
}

func TestAdjudicateReturnToRelativeNull(t *testing.T) {
	for _, raw := range []string{"/projects/42", "//127.0.0.1:5173/projects"} {
		if got := AdjudicateReturnTo(raw, returnToAllowed); got != nil {
			t.Errorf("相对/协议相对地址 %q 应回 nil，得 %v", raw, *got)
		}
	}
}

func TestAdjudicateReturnToDifferentPortNull(t *testing.T) {
	if got := AdjudicateReturnTo("http://127.0.0.1:5174/x", returnToAllowed); got != nil {
		t.Errorf("端口不同即不同 origin，得 %v", *got)
	}
}

func TestAdjudicateReturnToLocalhostVsLoopbackNull(t *testing.T) {
	if got := AdjudicateReturnTo("http://localhost:5173/x", returnToAllowed); got != nil {
		t.Errorf("localhost 与 127.0.0.1 互不认，得 %v", *got)
	}
}

func TestAdjudicateReturnToNonHTTPSchemeNull(t *testing.T) {
	for _, raw := range []string{"javascript:alert(1)", "data:text/html,hi"} {
		if got := AdjudicateReturnTo(raw, returnToAllowed); got != nil {
			t.Errorf("%q 协议非 http/https 应回 nil，得 %v", raw, *got)
		}
	}
}

func TestAdjudicateReturnToBackslashOnlyChangesPath(t *testing.T) {
	// WHATWG 对 special scheme 把 \ 当路径分隔符：主机因此停在名单里的 127.0.0.1:5173，
	// 跳转出不了外站。守护的不变量是「结果 origin 仍是名单内的那个」，不钉死归一后 @
	// 之前有几个斜杠——斜杠折叠方式是 URL 解析器的实现细节。
	result := AdjudicateReturnTo("http://127.0.0.1:5173\\@evil.example", returnToAllowed)
	if result == nil {
		t.Fatal("反斜杠变形应当通过裁决")
	}
	// 结果的 origin 仍是名单内那个：scheme://host 前缀逐字等于名单条目，且其后只剩路径。
	for _, allowed := range returnToAllowed {
		if strings.HasPrefix(*result, allowed+"/") || *result == allowed {
			return
		}
	}
	t.Errorf("结果 origin 仍应是名单内那个：%q", *result)
}

func TestAdjudicateReturnToUserinfoDisguiseNull(t *testing.T) {
	// host 取 @ 之后的 evil.example，origin 因此不在名单内。
	if got := AdjudicateReturnTo("http://127.0.0.1:5173@evil.example/", returnToAllowed); got != nil {
		t.Errorf("userinfo 伪装应回 nil，得 %v", *got)
	}
}

func TestAdjudicateReturnToHostnameGateOnForeignDomain(t *testing.T) {
	if got := AdjudicateReturnTo("http://evil.example/x", []string{"http://evil.example"}); got != nil {
		t.Errorf("名单被误写进外域时 hostname 闸仍应回 nil，得 %v", *got)
	}
}

func TestAdjudicateReturnToExactMaxLengthBoundary(t *testing.T) {
	base := "http://127.0.0.1:5173/"
	exact := base + strings.Repeat("a", ReturnToMaxLength-len(base))
	if len(exact) != ReturnToMaxLength {
		t.Fatalf("构造长度 %d，期望 %d", len(exact), ReturnToMaxLength)
	}
	got := AdjudicateReturnTo(exact, returnToAllowed)
	if got == nil || *got != exact {
		t.Errorf("恰好 %d 字符应被接受并原样返回，得 %v", ReturnToMaxLength, got)
	}
	// 超一个字符就落到长度闸之外，不交给 URL 解析。
	if got := AdjudicateReturnTo(exact+"a", returnToAllowed); got != nil {
		t.Errorf("超一字符应回 nil，得 %v", *got)
	}
}

func TestAdjudicateReturnToOverlongSkipsParsing(t *testing.T) {
	long := "http://127.0.0.1:5173/" + strings.Repeat("a", ReturnToMaxLength)
	if got := AdjudicateReturnTo(long, returnToAllowed); got != nil {
		t.Errorf("超长直接 null，得 %v", *got)
	}
}
