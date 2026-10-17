package platform

import (
	"fmt"
	"syscall"
)

// statfsUsage 读取挂载点容量；statfs 跟随符号链接，面板数据目录指向持久卷时读到的是卷。
// Bsize/Blocks 的底层类型在 linux 各架构与 darwin 之间不同，这里统一换算成 uint64；
// 设备标识取 Fsid（linux 的 Statfs_t 不是每个架构都有 Dev 字段）。
func statfsUsage(path string) (diskUsage, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return diskUsage{}, err
	}
	if st.Bsize == 0 || st.Blocks == 0 || st.Bfree > st.Blocks {
		return diskUsage{}, fmt.Errorf("文件系统容量字段无效")
	}
	block := uint64(st.Bsize)
	return diskUsage{
		TotalBytes: st.Blocks * block,
		UsedBytes:  (st.Blocks - st.Bfree) * block,
		FreeBytes:  st.Bavail * block,
		Device:     fmt.Sprint(st.Fsid),
	}, nil
}
