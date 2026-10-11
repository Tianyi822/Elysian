package files

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"elysian/server/internal/shared"
)

func openDownloadPath(path string, directory bool) (*os.File, error) {
	parent, err := uploadOpenDirectory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if directory {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat(int(parent.Fd()), filepath.Base(path), flags, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

func (m *TransferManager) prepareDownload(ctx context.Context, input string) (*preparedDownload, error) {
	path, err := normalizeServerFilePath(input)
	if err != nil {
		return nil, err
	}
	if path == "/" {
		return nil, shared.InvalidRequest("根目录不能下载")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		if isMissingPathError(err) {
			return nil, shared.InvalidRequest("下载路径不存在：" + path)
		}
		return nil, fmt.Errorf("无法读取下载路径：%w", err)
	}
	if _, hit := matchPathPrefix(path, virtualFsPrefixes); hit {
		return nil, shared.InvalidRequest("拒绝下载系统虚拟目录或文件")
	}
	if _, hit := matchPathPrefix(resolved, virtualFsPrefixes); hit {
		return nil, shared.InvalidRequest("拒绝下载系统虚拟目录或文件")
	}
	if resolved == "/" {
		return nil, shared.InvalidRequest("根目录不能下载")
	}
	initialInfo, err := os.Lstat(resolved)
	if err != nil {
		return nil, fmt.Errorf("无法读取下载路径：%w", err)
	}
	if !initialInfo.IsDir() && !initialInfo.Mode().IsRegular() {
		return nil, shared.InvalidRequest("只能下载普通文件或目录，不能下载设备、管道或套接字")
	}
	f, err := openDownloadPath(resolved, false)
	if err != nil {
		return nil, fmt.Errorf("无法打开下载文件：%w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if !os.SameFile(initialInfo, info) {
		_ = f.Close()
		return nil, transferError(409, "下载路径在准备期间发生变化，请重试")
	}
	if info.Mode().IsRegular() {
		return &preparedDownload{file: f, info: info, result: downloadResult{Name: leafNameOf(path), SizeBytes: info.Size()}}, nil
	}
	if !info.IsDir() {
		_ = f.Close()
		return nil, shared.InvalidRequest("只能下载普通文件或目录，不能下载设备、管道或套接字")
	}
	defer f.Close()
	select {
	case m.packing <- struct{}{}:
		defer func() { <-m.packing }()
	default:
		return nil, transferError(429, "已有目录正在打包，请稍后重试")
	}
	archive, err := m.archiveFile()
	if err != nil {
		return nil, err
	}
	writer := &archiveBudgetWriter{ctx: ctx, manager: m, file: archive}
	success := false
	defer func() {
		if !success {
			_ = archive.Close()
			m.mu.Lock()
			m.archiveBytes -= writer.written
			m.mu.Unlock()
		}
	}()
	gz := gzip.NewWriter(writer)
	tw := tar.NewWriter(gz)
	rootName := leafNameOf(path)
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return nil, err
	}
	header.Name = rootName + "/"
	if err = tw.WriteHeader(header); err != nil {
		return nil, err
	}
	count := 0
	if err = writeDownloadDirectory(ctx, tw, f, rootName, resolved, 0, &count); err != nil {
		return nil, fmt.Errorf("目录打包失败：%w", err)
	}
	if err = tw.Close(); err != nil {
		return nil, fmt.Errorf("目录打包失败：%w", err)
	}
	if err = gz.Close(); err != nil {
		return nil, fmt.Errorf("目录打包失败：%w", err)
	}
	if _, err = archive.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	success = true
	return &preparedDownload{file: archive, archive: true, result: downloadResult{Name: rootName + ".tar.gz", SizeBytes: writer.written}}, nil
}

type archiveBudgetWriter struct {
	ctx     context.Context
	manager *TransferManager
	file    *os.File
	written int64
}

func (w *archiveBudgetWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	w.manager.mu.Lock()
	defer w.manager.mu.Unlock()
	if int64(len(p)) > w.manager.archiveLimit-w.written {
		return 0, transferError(413, "目录压缩包超过 10 GiB 上限")
	}
	if int64(len(p)) > w.manager.totalLimit-w.manager.archiveBytes {
		return 0, transferError(413, "下载压缩包暂存总量超过 20 GiB 上限")
	}
	n, err := w.file.Write(p)
	w.written += int64(n)
	w.manager.archiveBytes += int64(n)
	return n, err
}

type downloadContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r downloadContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func writeDownloadDirectory(ctx context.Context, tw *tar.Writer, dir *os.File, archiveDir, sourceDir string, depth int, count *int) error {
	if depth >= walkMaxDepth {
		return shared.InvalidRequest(operationLimitMessage)
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, err := dir.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, entry := range entries {
			*count++
			if *count > walkMaxNodes {
				return shared.InvalidRequest(operationLimitMessage)
			}
			name := entry.Name()
			if name == "." || name == ".." || strings.Contains(name, "/") || hasControlChars(name) {
				return shared.InvalidRequest("目录包含无效文件名")
			}
			var stat unix.Stat_t
			if err := unix.Fstatat(int(dir.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return err
			}
			member := archiveDir + "/" + name
			source := childPathOf(sourceDir, name)
			if _, hit := matchPathPrefix(source, virtualFsPrefixes); hit {
				return shared.InvalidRequest("目录包含系统虚拟目录，无法下载")
			}
			typeBits := stat.Mode & unix.S_IFMT
			if typeBits == unix.S_IFLNK {
				buf := make([]byte, filePathMaxLength+1)
				n, err := unix.Readlinkat(int(dir.Fd()), name, buf)
				if err != nil {
					return err
				}
				if n >= len(buf) {
					return shared.InvalidRequest("目录包含超长符号链接")
				}
				header := &tar.Header{Name: member, Typeflag: tar.TypeSymlink, Linkname: string(buf[:n]), Mode: int64(stat.Mode & 0777), Uid: int(stat.Uid), Gid: int(stat.Gid)}
				if err := tw.WriteHeader(header); err != nil {
					return err
				}
				continue
			}
			if typeBits != unix.S_IFREG && typeBits != unix.S_IFDIR {
				return shared.InvalidRequest("目录包含设备、管道或套接字，无法下载")
			}
			flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
			if typeBits == unix.S_IFDIR {
				flags |= unix.O_DIRECTORY
			}
			fd, err := unix.Openat(int(dir.Fd()), name, flags, 0)
			if err != nil {
				return err
			}
			child := os.NewFile(uintptr(fd), name)
			err = writeDownloadMember(ctx, tw, child, member, source, depth, count, typeBits == unix.S_IFDIR)
			_ = child.Close()
			if err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}

func writeDownloadMember(ctx context.Context, tw *tar.Writer, f *os.File, name, source string, depth int, count *int, directory bool) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() != directory || (!info.IsDir() && !info.Mode().IsRegular()) {
		return shared.InvalidRequest("下载条目在打包期间被替换")
	}
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = name
	if directory {
		header.Name += "/"
	}
	if err = tw.WriteHeader(header); err != nil {
		return err
	}
	if directory {
		return writeDownloadDirectory(ctx, tw, f, name, source, depth+1, count)
	}
	if _, err = io.CopyN(tw, downloadContextReader{ctx, f}, info.Size()); err != nil {
		return err
	}
	after, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, after) || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return shared.InvalidRequest("文件在打包期间发生变化，请重试")
	}
	return nil
}
