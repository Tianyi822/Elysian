package firewall

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 规则文件的落盘方式（hostFiles.ts 等价物）：原子写与内核接口路径判定单独成模块，
// 由测试直接覆盖。

// atomicWriteText 原子写文件：先写同目录的隐藏临时文件，再 rename 替换（同目录
// rename 在 POSIX 上是原子操作）。半截写入会留下损坏的 before.rules，ufw 装载失败后
// 停在不设防的停用态，因此规则文件的落绝不直接写到目标路径。
func atomicWriteText(path string, content string) error {
	temp := filepath.Join(filepath.Dir(path), fmt.Sprintf(".%s.elysian-tmp-%s", filepath.Base(path), randomSuffix()))
	err := os.WriteFile(temp, []byte(content), 0o644)
	if err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// randomSuffix 生成随机后缀（形如 UUID 的一次性名字；名字本身无行为约束，
// 同目录与失败清理才是契约）。
func randomSuffix() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand 失败极罕见：退化为时间戳保证仍可写出不同临时名。
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

// isKernelInterfacePath 内核接口路径（procfs/sysfs）：解封 IP 写 /proc/net/xt_recent/
// <名单>、开启内核转发写 /proc/sys/net/ipv4/ip_forward 都落在这些目录下。它们是内核
// 暴露的节点，目录本身不可写、rename 也不被支持，「同目录临时文件 + rename」必然
// 失败，只有直接写才能落到内核接口上。
func isKernelInterfacePath(path string) bool {
	return strings.HasPrefix(path, "/proc/") || strings.HasPrefix(path, "/sys/")
}

// writeHostFile 按目标选择落盘方式：内核接口直接写目标，普通文件原子替换。
func writeHostFile(path string, content string) error {
	if isKernelInterfacePath(path) {
		return os.WriteFile(path, []byte(content), 0o644)
	}
	return atomicWriteText(path, content)
}
