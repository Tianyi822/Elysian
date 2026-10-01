package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

// 密码哈希（passwordHasher.ts 等价物）：golang.org/x/crypto/scrypt 产出原始字节后按
// TS 版同一格式串拼装/解析——存量凭据文件（TS 版产出）必须继续可验（迁移红线）。
//
// 格式串 `scrypt:N:r:p:<saltBase64>:<hashBase64>`（标准 base64 带 padding，非 base64url）：
// 参数随哈希一起落盘，verify 按串内参数派生——改参数只影响新哈希。
//
// verify 对格式非法的 stored 一律回 false、绝不报错：凭据文件被写坏时登录恒拒绝
// （fail closed），而不是 500。

// scrypt 派生参数：N=16384、r=8、p=1（OWASP 2023 对交互式登录的推荐档），派生键 32 字节。
const (
	scryptN         = 16384
	scryptR         = 8
	scryptP         = 1
	scryptKeyLength = 32
	saltLength      = 16

	// scryptMaxCost N*r*p 的上限（2^30）：参数被恶意写大时拒绝派生，防 CPU 耗尽。
	scryptMaxCost = 1 << 30
)

// PasswordHasher 密码哈希器。Verify 恒定时间比较；stored 格式非法一律回 false。
type PasswordHasher interface {
	// Hash 生成 `scrypt:N:r:p:<saltB64>:<hashB64>` 格式串（盐 16 字节随机）。
	Hash(plain string) (string, error)
	// Verify 按串内参数派生并恒定时间比较；stored 格式非法回 (false, nil) 绝不报错；
	// 仅派生本身失败（如内存不足）才返回 error。
	Verify(plain, stored string) (bool, error)
}

type scryptHasher struct{}

// NewScryptHasher 构造 scrypt 哈希器（与 TS createScryptHasher 同参数、同格式串）。
func NewScryptHasher() PasswordHasher { return scryptHasher{} }

// storedHash 解析后的格式串成分。
type storedHash struct {
	n, r, p int
	salt    []byte
	hash    []byte
}

// parseStored 解析格式串；任何一段不合法都回 false（Verify 据此回 false，不报错）。
func parseStored(stored string) (storedHash, bool) {
	parts := strings.Split(stored, ":")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return storedHash{}, false
	}
	n, errN := strconv.Atoi(parts[1])
	r, errR := strconv.Atoi(parts[2])
	p, errP := strconv.Atoi(parts[3])
	if errN != nil || errR != nil || errP != nil {
		return storedHash{}, false
	}
	if n <= 0 || r <= 0 || p <= 0 || int64(n)*int64(r)*int64(p) > scryptMaxCost {
		return storedHash{}, false
	}
	salt, errSalt := base64.StdEncoding.DecodeString(parts[4])
	if errSalt != nil {
		return storedHash{}, false
	}
	hash, errHash := base64.StdEncoding.DecodeString(parts[5])
	if errHash != nil {
		return storedHash{}, false
	}
	if len(salt) == 0 || len(hash) == 0 {
		return storedHash{}, false
	}
	return storedHash{n: n, r: r, p: p, salt: salt, hash: hash}, true
}

// Hash 实现 PasswordHasher。
func (scryptHasher) Hash(plain string) (string, error) {
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("生成盐失败：%w", err)
	}
	derived, err := scrypt.Key([]byte(plain), salt, scryptN, scryptR, scryptP, scryptKeyLength)
	if err != nil {
		return "", fmt.Errorf("scrypt 派生失败：%w", err)
	}
	return fmt.Sprintf("scrypt:%d:%d:%d:%s:%s", scryptN, scryptR, scryptP,
		base64.StdEncoding.EncodeToString(salt), base64.StdEncoding.EncodeToString(derived)), nil
}

// Verify 实现 PasswordHasher：格式非法回 false；派生键长度与存档不一致回 false；比较恒定时间。
func (scryptHasher) Verify(plain, stored string) (bool, error) {
	s, ok := parseStored(stored)
	if !ok {
		return false, nil
	}
	derived, err := scrypt.Key([]byte(plain), s.salt, s.n, s.r, s.p, len(s.hash))
	if err != nil {
		return false, fmt.Errorf("scrypt 派生失败：%w", err)
	}
	return len(derived) == len(s.hash) && subtle.ConstantTimeCompare(derived, s.hash) == 1, nil
}
