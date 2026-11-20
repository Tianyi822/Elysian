package database

import (
	"os"
	"syscall"

	"elysian/server/internal/atomicfile"
	"elysian/server/internal/shared/randomid"
)

// 登记文件的公共读写纪律（databaseRegistry.ts 与 sqliteService.ts 同构）：
// O_NOFOLLOW 打开、stat 身份校验、临时文件 + fsync + rename 原子替换。

// isNoEntry 判定错误是否为 ENOENT（文件不存在）。
func isNoEntry(err error) bool {
	return err != nil && os.IsNotExist(err)
}

func newUUID() string { return randomid.UUIDv4() }

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
