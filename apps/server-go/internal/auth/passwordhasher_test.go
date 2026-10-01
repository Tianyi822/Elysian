package auth

import (
	"regexp"
	"strings"
	"testing"
)

// 密码哈希契约测试（passwordHasher.test.ts 对等用例）：scrypt 往返、格式串解析与
// 恒定时间比较。golang.org/x/crypto/scrypt 与 TS node:crypto scrypt 产出的派生键
// 相同（同一 PBKDF），存量 TS 凭据文件因此继续可验。

func TestScryptHashRoundTrip(t *testing.T) {
	hasher := NewScryptHasher()
	stored, err := hasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatalf("Hash 失败：%v", err)
	}
	if !regexp.MustCompile(`^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`).MatchString(stored) {
		t.Errorf("格式串形状不符：%q", stored)
	}
	ok, err := hasher.Verify("correct horse battery staple", stored)
	if err != nil || !ok {
		t.Errorf("Verify(正确密码) = (%v, %v)，期望 (true, nil)", ok, err)
	}
}

func TestScryptVerifyWrongPassword(t *testing.T) {
	hasher := NewScryptHasher()
	stored, err := hasher.Hash("right-password")
	if err != nil {
		t.Fatalf("Hash 失败：%v", err)
	}
	ok, err := hasher.Verify("wrong-password", stored)
	if err != nil || ok {
		t.Errorf("Verify(错误密码) = (%v, %v)，期望 (false, nil)", ok, err)
	}
}

func TestScryptVerifyInvalidStoredNeverErrors(t *testing.T) {
	hasher := NewScryptHasher()
	zeros16 := "AAAAAAAAAAAAAAAAAAAAAA=="
	zeros32 := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	invalid := []string{
		"",                                  // 空串
		"plain-text",                        // 纯文本
		"scrypt:16384:8:1",                  // 缺段
		"scrypt:16384:8:1:only-one-segment", // 缺哈希段
		"bcrypt:16384:8:1:aaaa:bbbb",        // 前缀不是 scrypt
		"scrypt:abc:8:1:" + zeros16 + ":" + zeros32, // 参数非数字
		"scrypt:16384:8:1:!!!not-base64!!!:####",    // 坏 base64
	}
	for _, stored := range invalid {
		ok, err := hasher.Verify("whatever", stored)
		if err != nil {
			t.Errorf("Verify(%q) 报错：%v（格式非法一律回 false 绝不报错）", stored, err)
		}
		if ok {
			t.Errorf("Verify(%q) = true，期望 false", stored)
		}
	}
}

func TestScryptSaltRandom(t *testing.T) {
	hasher := NewScryptHasher()
	first, err := hasher.Hash("same-plain")
	if err != nil {
		t.Fatalf("第一次 Hash 失败：%v", err)
	}
	second, err := hasher.Hash("same-plain")
	if err != nil {
		t.Fatalf("第二次 Hash 失败：%v", err)
	}
	if first == second {
		t.Fatal("同明文两次哈希产出相同串，盐应当随机")
	}
	firstSalt := strings.Split(first, ":")[4]
	secondSalt := strings.Split(second, ":")[4]
	if firstSalt == secondSalt {
		t.Errorf("两次哈希的盐段相同（%q），期望不同", firstSalt)
	}
	for _, stored := range []string{first, second} {
		ok, err := hasher.Verify("same-plain", stored)
		if err != nil || !ok {
			t.Errorf("Verify(same-plain, %q) = (%v, %v)，期望 (true, nil)", stored, ok, err)
		}
	}
}

func TestDummyHashIsWellFormedScrypt(t *testing.T) {
	hasher := NewScryptHasher()
	// 哑哈希常量是格式合法的 scrypt 串：verify 可正常跑完并回 false——时序对齐的前提。
	ok, err := hasher.Verify("any-input", DummyHash)
	if err != nil {
		t.Fatalf("Verify(DUMMY_HASH) 报错：%v", err)
	}
	if ok {
		t.Error("Verify(any-input, DUMMY_HASH) = true，期望 false")
	}
}
