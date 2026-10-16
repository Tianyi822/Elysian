package websites

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// 不接受反斜杠、绝对路径、链接或特殊文件。每次提取只写全新私有目录。
func archivePath(root, name string) (string, error) {
	if strings.ContainsAny(name, "\\\x00") || filepath.IsAbs(name) || (len(name) >= 2 && name[1] == ':') {
		return "", errors.New("压缩包包含不安全路径")
	}
	clean := filepath.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("压缩包包含路径穿越")
	}
	if clean == "." {
		return root, nil
	}
	return filepath.Join(root, clean), nil
}

type extractBudget struct {
	bytes   int64
	entries int
	limits  deploymentLimits
}

func (b *extractBudget) write(ctx context.Context, root, name string, size int64, mode os.FileMode, r io.Reader, dir bool) error {
	b.entries++
	if b.entries > b.limits.Entries || size < 0 || size > b.limits.ExpandedBytes-b.bytes {
		return errors.New("压缩包展开后超过大小或条目上限")
	}
	b.bytes += size
	target, err := archivePath(root, name)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if dir {
		return os.MkdirAll(target, 0755)
	}
	if target == root {
		return errors.New("压缩包文件路径无效")
	}
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()&0755|0600)
	if err != nil {
		return fmt.Errorf("压缩包条目重复或无法创建：%w", err)
	}
	_, err = io.CopyN(f, contextReader{ctx, r}, size)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}
func extractArchive(ctx context.Context, filename, root string, limits deploymentLimits) error {
	b := extractBudget{limits: limits}
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	magic := make([]byte, 4)
	if _, err = io.ReadFull(f, magic); err != nil {
		return errors.New("压缩包损坏")
	}
	if _, err = f.Seek(0, 0); err != nil {
		return err
	}
	if string(magic[:2]) == "PK" {
		info, err := f.Stat()
		if err != nil {
			return err
		}
		zr, err := zip.NewReader(f, info.Size())
		if err != nil {
			return errors.New("ZIP 压缩包损坏")
		}
		if len(zr.File) > limits.Entries {
			return errors.New("压缩包展开后超过条目上限")
		}
		for _, z := range zr.File {
			if !z.Mode().IsRegular() && !z.FileInfo().IsDir() {
				return errors.New("压缩包不允许链接或特殊文件")
			}
			if z.UncompressedSize64 > uint64(limits.ExpandedBytes) {
				return errors.New("压缩包展开后超过大小上限")
			}
			rc, err := z.Open()
			if err != nil {
				return err
			}
			err = b.write(ctx, root, z.Name, int64(z.UncompressedSize64), z.Mode(), rc, z.FileInfo().IsDir())
			if err == nil {
				var one [1]byte
				_, e := rc.Read(one[:])
				if e != io.EOF {
					err = errors.New("ZIP 大小或校验无效")
				}
			}
			_ = rc.Close()
			if err != nil {
				return err
			}
		}
		return nil
	}
	if magic[0] != 0x1f || magic[1] != 0x8b {
		return errors.New("仅支持 ZIP 或 tar.gz 压缩包")
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return errors.New("tar.gz 压缩包损坏")
	}
	defer gz.Close()
	if err = extractTar(ctx, tar.NewReader(gz), root, &b, ""); err != nil {
		return err
	}
	n, err := io.Copy(io.Discard, contextReader{ctx, io.LimitReader(gz, limits.ExpandedBytes-b.bytes+1)})
	if n > limits.ExpandedBytes-b.bytes {
		return errors.New("压缩包尾部数据超过展开上限")
	}
	return err
}
func extractTar(ctx context.Context, tr *tar.Reader, root string, b *extractBudget, strip string) error {
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return errors.New("TAR 压缩包损坏")
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA && h.Typeflag != tar.TypeDir {
			return errors.New("压缩包不允许链接或特殊文件")
		}
		name := h.Name
		if strip != "" {
			clean := filepath.Clean(name)
			if clean == strip {
				if h.Typeflag == tar.TypeDir {
					continue
				}
				return errors.New("导出目录无效")
			}
			if !strings.HasPrefix(clean, strip+"/") {
				return errors.New("导出目录包含意外路径")
			}
			name = strings.TrimPrefix(clean, strip+"/")
		}
		if err = b.write(ctx, root, name, h.Size, os.FileMode(h.Mode), tr, h.Typeflag == tar.TypeDir); err != nil {
			return err
		}
	}
}

// 归档输出从磁盘逐文件流式读取，拒绝构建程序生成的逃逸链接。
func tarDirectory(ctx context.Context, root string, w io.Writer) error {
	tw := tar.NewWriter(w)
	if err := tw.WriteHeader(&tar.Header{Name: "app", Typeflag: tar.TypeDir, Mode: 0700, Uid: 65532, Gid: 65532}); err != nil {
		return err
	}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		if path == root {
			return nil
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		if strings.HasPrefix(rel, ".git/") || rel == ".git" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("工作区包含链接或特殊文件")
		}
		h, e := tar.FileInfoHeader(info, "")
		if e != nil {
			return e
		}
		h.Name = "app/" + filepath.ToSlash(rel)
		h.Uid, h.Gid, h.Uname, h.Gname = 65532, 65532, "", ""
		h.Mode = h.Mode&0777 | 0600
		if info.IsDir() {
			h.Mode |= 0700
		}
		if e = tw.WriteHeader(h); e != nil {
			return e
		}
		if info.IsDir() {
			return nil
		}
		f, e := os.Open(path)
		if e != nil {
			return e
		}
		_, e = io.Copy(tw, contextReader{ctx, f})
		ce := f.Close()
		if e != nil {
			return e
		}
		return ce
	})
	ce := tw.Close()
	if err != nil {
		return err
	}
	return ce
}
