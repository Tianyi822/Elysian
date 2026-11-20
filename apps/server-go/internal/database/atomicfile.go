package database

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"syscall"

	"elysian/server/internal/atomicfile"
)

// 登记文件的公共读写纪律（databaseRegistry.ts 与 sqliteService.ts 同构）：
// O_NOFOLLOW 打开、stat 身份校验、临时文件 + fsync + rename 原子替换。

// isNoEntry 判定错误是否为 ENOENT（文件不存在）。
func isNoEntry(err error) bool {
	return err != nil && os.IsNotExist(err)
}

// newUUID 生成小写 UUID v4（TS crypto.randomUUID 等价物）。
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败属于系统级故障：直接 panic 由 recover 兜底为 500。
		panic(fmt.Sprintf("无法生成随机 ID：%v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	buf := make([]byte, 36)
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], b[10:16])
	return string(buf)
}

func statRegistryFile(info os.FileInfo) bool {
	uid := uint32(os.Getuid())
	return atomicfile.StatTrusted(info, atomicfile.TrustOptions{MaxBytes: registrySizeLimit, RejectPerm: 0o077, OwnerUID: &uid})
}

// nlinkOf 取硬链接数；取不到回 -1。
func nlinkOf(info os.FileInfo) int {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return int(st.Nlink)
	}
	return -1
}

// writeFileAtomic 临时文件 + fsync + rename 的原子替换写；目录按 0700 递归建。
// TS 版同构：wx 0600 开临时文件、写完 sync、rename 失败时清理临时文件。
func writeFileAtomic(path string, data []byte) error {
	return atomicfile.WriteFile(path, data, atomicfile.WriteOptions{
		CreateParent: true,
		TempSuffix:   func() string { return "." + newUUID() + ".tmp" },
	})
}
