package containerapps

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// 构建上下文打包（ADR-0021）：把 context 目录打成 tar 供 Engine /build 使用。
//
// 打包规则与 ListFiles 同源（files.go:38-71）：只收普通文件，目录本身不写条目，
// 符号链接目录不跟随、符号链接文件不收——上下文里不可能出现借符号链接指向
// 工作区之外的内容。daemon 在构建时自行应用上下文内的 .dockerignore，面板不做
// 模式匹配（有意取舍，见 ADR-0021 放弃的方案）。
//
// 打包是任务开始时的一次性快照：统计与写入同一次遍历完成，构建期间不锁工作区
// 文件，中途改动下一次构建才生效。128 MiB / 512 文件的硬校验在打包阶段执行，
// preview 阶段只预警不拒绝。

const (
	// maxContextBytes 构建上下文体积上限（与单工作区累计上限同值）。
	maxContextBytes int64 = 128 << 20
	// maxContextFiles 构建上下文文件数上限（与单工作区文件数上限同值）。
	maxContextFiles = 512
)

// contextStat 一次遍历的统计结果。
type contextStat struct {
	files int
	bytes int64
}

// statBuildContext 统计 context 目录的普通文件数与总字节（与打包同一规则）。
func statBuildContext(contextAbs string) (contextStat, error) {
	stat := contextStat{}
	err := walkContextFiles(contextAbs, func(_ string, info os.FileInfo) error {
		stat.files++
		stat.bytes += info.Size()
		return nil
	})
	return stat, err
}

// walkContextFiles 按打包规则遍历 context 目录里的普通文件（相对路径以正斜杠回传）。
func walkContextFiles(contextAbs string, visit func(rel string, info os.FileInfo) error) error {
	return filepath.Walk(contextAbs, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			// 符号链接目录不跟随，避免绕出工作区。
			if info.Mode()&os.ModeSymlink != 0 {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(contextAbs, path)
		if relErr != nil {
			return relErr
		}
		return visit(filepath.ToSlash(rel), info)
	})
}

// spoolTarPath 构建上下文 tar 的 spool 路径：<tmp>/container-app-builds/<id>.tar。
func spoolTarPath(spoolRoot, taskID string) string {
	return filepath.Join(spoolRoot, taskID+".tar")
}

// writeContextTar 把 context 目录打包到 dest（0600），打包阶段执行硬校验。
// 超限返回任务内失败文案（逐字），半成品 tar 一律清理。
func writeContextTar(contextAbs, dest string) (contextStat, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return contextStat{}, err
	}
	file, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return contextStat{}, err
	}
	destName := dest
	cleanup := func() { _ = file.Close(); _ = os.Remove(destName) }

	writer := tar.NewWriter(file)
	stat := contextStat{}
	writeErr := walkContextFiles(contextAbs, func(rel string, info os.FileInfo) error {
		if stat.files+1 > maxContextFiles {
			return errors.New("构建上下文文件数超过上限 512 个，已中止")
		}
		if stat.bytes+info.Size() > maxContextBytes {
			return errors.New("构建上下文超过上限 128 MiB，已中止")
		}
		source, err := os.Open(filepath.Join(contextAbs, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		defer source.Close()
		header := &tar.Header{
			Name:    rel,
			Mode:    int64(info.Mode().Perm()),
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Format:  tar.FormatPAX,
		}
		if err = writer.WriteHeader(header); err != nil {
			return err
		}
		written, err := io.Copy(writer, source)
		if err != nil {
			return err
		}
		if written != info.Size() {
			return fmt.Errorf("打包 %s 时文件发生变化，请重试", rel)
		}
		stat.files++
		stat.bytes += info.Size()
		return nil
	})
	if writeErr == nil {
		writeErr = writer.Flush()
	}
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := writer.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	closeErr = file.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		cleanup()
		return stat, writeErr
	}
	return stat, nil
}

// readTarEntry 读 tar 内一个普通文件条目的内容（按归一化正斜杠路径匹配）；缺该
// 条目返回中文错误。任务执行中的权威 FROM 预检用它读 tar 快照，保证校验对象与
// 送引擎构建对象是同一份数据。
func readTarEntry(tarPath, rel string) ([]byte, error) {
	file, err := os.Open(tarPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	want := filepath.ToSlash(filepath.Clean(rel))
	reader := tar.NewReader(file)
	for {
		header, nextErr := reader.Next()
		if nextErr == io.EOF {
			return nil, fmt.Errorf("构建上下文内没有 %s", rel)
		}
		if nextErr != nil {
			return nil, nextErr
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.ToSlash(filepath.Clean(header.Name)) != want {
			continue
		}
		return io.ReadAll(reader)
	}
}
