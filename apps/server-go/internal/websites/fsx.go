package websites

import (
	"errors"
	"io/fs"
	"os"

	"elysian/server/internal/atomicfile"
	"elysian/server/internal/jscompat"
	"elysian/server/internal/shared/randomid"
)

// 面板数据文件的读写纪律（websitesRegistry.ts / websitesCertificates.ts 同一套）：
// O_NOFOLLOW 读 + 权限/属主/大小校验、0700 目录、0600 临时文件 + fsync。登记走
// 「随机后缀临时文件 + rename 原子替换」，证书与版本目录缓存各自另有写法（见各自文件）。

// registryMaxBytes 网站登记文件体积上限：1 MiB（无界备注可把登记撑破到 list/remove
// 全体失败，写入侧与读侧同一上限闭环）。
const registryMaxBytes = 1024 * 1024

// certificateFileMaxBytes 单个证书材料文件体积上限：128 KiB。
const certificateFileMaxBytes = 128 * 1024

func websiteFilePolicy(maxBytes int64) atomicfile.TrustOptions {
	uid := uint32(os.Getuid())
	return atomicfile.TrustOptions{MaxBytes: maxBytes, RejectPerm: 0o077, OwnerUID: &uid}
}

// isENOENT 判定错误是否为文件不存在（目录/文件被外部抢先清理视为已完成）。
func isENOENT(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}

func randomUUID() string { return randomid.UUIDv4() }

// utf16Length 计算字符串的 UTF-16 code unit 数（与 JS string.length 同口径：BMP 外
// 字符计 2）。项目名 1-64、备注/命令/Git 地址上限、域名 253 上限都按它对齐 TS 语义。
func utf16Length(s string) int {
	return jscompat.UTF16Length(s)
}
