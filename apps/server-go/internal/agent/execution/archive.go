package execution

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

func relativePath(name string) bool {
	if name == "" || len(name) > 1024 || !utf8.ValidString(name) || strings.ContainsAny(name, "\\\x00") || path.IsAbs(name) || path.Clean(name) != name || name == "." {
		return false
	}
	for _, v := range strings.Split(name, "/") {
		if v == ".." || v == "." || v == "" {
			return false
		}
	}
	return true
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (r ctxReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// appendArchive 重新生成受限 TAR；不把来源元数据或链接交给 Docker 解包器。
func appendArchive(ctx context.Context, out *tar.Writer, input io.Reader, prefix string, maxBytes int64, maxFiles int) error {
	if input == nil {
		return nil
	}
	tr := tar.NewReader(ctxReader{ctx, input})
	seen := map[string]bool{}
	var size int64
	count := 0
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return problem(400, "execution-archive", "执行归档无效")
		}
		count++
		name := h.Name
		if h.Typeflag == tar.TypeDir {
			name = strings.TrimSuffix(name, "/")
		}
		if !relativePath(name) || seen[name] || count > maxFiles*2 || h.Linkname != "" || (h.Typeflag != tar.TypeDir && h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA) {
			return problem(400, "execution-archive", "执行归档包含不安全路径、重复条目或特殊文件")
		}
		for key := range h.PAXRecords {
			if strings.HasPrefix(key, "GNU.sparse") || strings.HasPrefix(key, "SCHILY.") {
				return problem(400, "execution-archive", "执行归档不支持稀疏文件或扩展元数据")
			}
		}
		seen[name] = true
		size += h.Size
		if h.Size < 0 || size > maxBytes {
			return problem(413, "execution-archive-limit", "执行归档超过容量上限")
		}
		mode := int64(0644)
		kind := byte(tar.TypeReg)
		if h.Typeflag == tar.TypeDir {
			mode = 0755
			kind = tar.TypeDir
			if h.Size != 0 {
				return problem(400, "execution-archive", "归档目录条目无效")
			}
		}
		if err = out.WriteHeader(&tar.Header{Name: prefix + "/" + name, Mode: mode, Size: h.Size, Typeflag: kind, Uid: 65532, Gid: 65532}); err != nil {
			return err
		}
		if _, err = io.CopyN(out, tr, h.Size); err != nil {
			return problem(400, "execution-archive", "执行归档内容不完整")
		}
	}
}

func (e *Executor) upload(ctx context.Context, id string, skill, workspace io.Reader) error {
	file, err := os.Open(e.options.SupervisorPath)
	if err != nil {
		return problem(503, "execution-supervisor", "执行二进制不可读取")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<20 {
		return problem(503, "execution-supervisor", "执行二进制无效或过大")
	}
	var signature [4]byte
	if _, err = file.ReadAt(signature[:], 0); err != nil || string(signature[:]) != "\x7fELF" {
		return problem(503, "execution-supervisor", "执行二进制必须为 Linux ELF 文件")
	}
	reader, writer := io.Pipe()
	completed := make(chan error, 1)
	go func() {
		tw := tar.NewWriter(writer)
		fail := func(err error) { _ = writer.CloseWithError(err); completed <- err }
		for _, name := range []string{"elysian", "skill", "initial-workspace"} {
			if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Typeflag: tar.TypeDir, Uid: 65532, Gid: 65532}); err != nil {
				fail(err)
				return
			}
		}
		if err := tw.WriteHeader(&tar.Header{Name: "elysian/supervisor", Mode: 0555, Size: info.Size(), Typeflag: tar.TypeReg, Uid: 65532, Gid: 65532}); err != nil {
			fail(err)
			return
		}
		if _, err := io.CopyN(tw, ctxReader{ctx, file}, info.Size()); err != nil {
			fail(err)
			return
		}
		if err := appendArchive(ctx, tw, skill, "skill", MaxSkillBytes, 2048); err != nil {
			fail(err)
			return
		}
		if err := appendArchive(ctx, tw, workspace, "initial-workspace", MaxWorkspaceBytes, MaxWorkspaceFiles); err != nil {
			fail(err)
			return
		}
		if err := tw.Close(); err != nil {
			fail(err)
			return
		}
		_ = writer.Close()
		completed <- nil
	}()
	uploadCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	resp, callErr := e.request(uploadCtx, "PUT", "/containers/"+id+"/archive?path=/bundle", reader, "application/x-tar")
	_ = reader.CloseWithError(callErr)
	buildErr := <-completed
	if callErr != nil {
		if buildErr != nil {
			return buildErr
		}
		return callErr
	}
	defer resp.Body.Close()
	if buildErr != nil {
		return buildErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return engineError()
	}
	return nil
}

func nofollowFile(name string) (*os.File, error) {
	if !filepath.IsAbs(name) {
		return nil, problem(400, "execution-path", "执行文件必须使用绝对路径")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(filepath.Clean(name), "/"), "/")
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, e := unix.Openat(fd, part, flags, 0)
		unix.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), name)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, problem(400, "execution-file", "执行输出不允许链接或特殊文件")
	}
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Nlink != 1 {
		f.Close()
		return nil, problem(400, "execution-file", "执行输出不允许硬链接")
	}
	return f, nil
}

func copyInitialWorkspace(ctx context.Context, source, destination string) error {
	var total int64
	count := 0
	return filepath.WalkDir(source, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if !relativePath(filepath.ToSlash(rel)) {
			return protocolError()
		}
		dest := filepath.Join(destination, rel)
		if entry.IsDir() {
			return os.MkdirAll(dest, 0700)
		}
		count++
		if count > MaxWorkspaceFiles {
			return protocolError()
		}
		f, err := nofollowFile(name)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		total += info.Size()
		if total > MaxWorkspaceBytes {
			return protocolError()
		}
		if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = io.CopyN(out, ctxReader{ctx, f}, info.Size())
		closeErr := out.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
}

func writeWorkspace(ctx context.Context, root string, writer io.Writer) error {
	tw := tar.NewWriter(writer)
	var total int64
	count := 0
	err := filepath.WalkDir(root, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if name == root {
			return nil
		}
		rel, err := filepath.Rel(root, name)
		if err != nil || !relativePath(filepath.ToSlash(rel)) {
			return protocolError()
		}
		if entry.IsDir() {
			return nil
		}
		count++
		if count > MaxWorkspaceFiles {
			return problem(413, "execution-workspace-limit", "执行工作区文件数量超过上限")
		}
		f, err := nofollowFile(name)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		total += info.Size()
		if total > MaxWorkspaceBytes {
			return problem(413, "execution-workspace-limit", "执行工作区超过容量上限")
		}
		if err = tw.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Mode: 0600, Typeflag: tar.TypeReg, Size: info.Size()}); err != nil {
			return err
		}
		_, err = io.CopyN(tw, ctxReader{ctx, f}, info.Size())
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
}
