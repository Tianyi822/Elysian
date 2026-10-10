package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var skillName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func parseManifest(raw []byte) (Manifest, error) {
	var manifest Manifest
	if !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 || len(raw) > 1<<20 {
		return manifest, problem(400, "invalid-skill", "SKILL.md 必须为不超过 1 MiB 的 UTF-8 文本")
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return manifest, problem(400, "invalid-frontmatter", "SKILL.md 必须以 YAML frontmatter 开头")
	}
	end := strings.Index(text[4:], "\n---\n")
	if end < 0 {
		return manifest, problem(400, "invalid-frontmatter", "SKILL.md 缺少 frontmatter 结束分隔行")
	}
	front := text[4 : 4+end]
	if len(front) > 64<<10 {
		return manifest, problem(400, "invalid-frontmatter", "技能元数据超过 64 KiB")
	}
	decoder := yaml.NewDecoder(strings.NewReader(front))
	decoder.KnownFields(true)
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, problem(400, "invalid-frontmatter", "技能元数据格式无效或包含不支持字段")
	}
	if len(manifest.Name) > 64 || !skillName.MatchString(manifest.Name) || strings.TrimSpace(manifest.Description) == "" || utf8.RuneCountInString(manifest.Description) > 1024 || utf8.RuneCountInString(manifest.Compatibility) > 500 {
		return manifest, problem(400, "invalid-frontmatter", "技能 name、description 或 compatibility 不符合格式与长度要求")
	}
	if strings.TrimSpace(text[4+end+5:]) == "" {
		return manifest, problem(400, "invalid-skill", "SKILL.md 必须包含技能指令正文")
	}
	return manifest, nil
}

type packageBuilder struct {
	limits Limits
	bytes  int64
	files  []File
	seen   map[string]bool
}

func (b *packageBuilder) add(ctx context.Context, name string, reader io.Reader, destination string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	name, err := cleanRelative(name)
	if err != nil {
		return err
	}
	if b.seen == nil {
		b.seen = map[string]bool{}
	}
	if b.seen[name] {
		return problem(400, "duplicate-file", "技能包包含重复文件路径")
	}
	b.seen[name] = true
	if len(b.files) >= b.limits.Files {
		return problem(413, "skill-file-limit", "技能包文件数量超过限额")
	}
	f, err := createRegular(filepath.Join(destination, filepath.FromSlash(name)))
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(contextReader{ctx, reader}, b.limits.PackageBytes-b.bytes+1))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return storageError()
	}
	b.bytes += n
	if b.bytes > b.limits.PackageBytes {
		return problem(413, "skill-size-limit", "技能包解压后超过容量限额")
	}
	b.files = append(b.files, File{Path: name, Size: n, Digest: hex.EncodeToString(hash.Sum(nil))})
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (b *packageBuilder) directory(ctx context.Context, source, destination string) error {
	root, err := openDirectory(source, false)
	if err != nil {
		return err
	}
	root.Close()
	// 每个叶子打开时重新以 no-follow 逐级打开，防止路径检查后的链接替换。
	return filepath.WalkDir(source, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return problem(400, "invalid-source", "技能来源目录不可读取")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, e := filepath.Rel(source, name)
		if e != nil {
			return problem(400, "invalid-source", "技能来源目录无效")
		}
		if relative == "." {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			d, e := openDirectory(name, false)
			if e != nil {
				return e
			}
			return d.Close()
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return problem(400, "unsafe-file", "技能包不允许链接或特殊文件")
		}
		f, e := openRegular(name)
		if e != nil {
			return problem(400, "unsafe-file", "技能来源文件不可读取或包含链接")
		}
		e = b.add(ctx, filepath.ToSlash(relative), f, destination)
		closeErr := f.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return problem(400, "invalid-source", "技能来源文件读取未完成")
		}
		return nil
	})
}
func (b *packageBuilder) archive(ctx context.Context, source, destination string) error {
	f, err := openRegular(source)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return storageError()
	}
	archive, err := zip.NewReader(f, stat.Size())
	if err != nil {
		return problem(400, "invalid-zip", "技能 ZIP 无效")
	}
	if len(archive.File) > b.limits.Files*2 {
		return problem(413, "skill-file-limit", "技能 ZIP 条目数量超过限额")
	}
	for _, item := range archive.File {
		if err = ctx.Err(); err != nil {
			return err
		}
		name := strings.TrimSuffix(item.Name, "/")
		if _, err = cleanRelative(name); err != nil {
			return err
		}
		if item.Mode().IsDir() {
			continue
		}
		if !item.Mode().IsRegular() {
			return problem(400, "unsafe-file", "技能 ZIP 不允许链接或特殊文件")
		}
		if item.UncompressedSize64 > uint64(b.limits.PackageBytes-b.bytes) {
			return problem(413, "skill-size-limit", "技能 ZIP 解压后超过容量限额")
		}
		reader, e := item.Open()
		if e != nil {
			return problem(400, "invalid-zip", "技能 ZIP 文件不可读取")
		}
		e = b.add(ctx, name, reader, destination)
		reader.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
func (b *packageBuilder) finish(destination string) (Manifest, string, error) {
	raw, err := readBounded(filepath.Join(destination, "SKILL.md"), 1<<20)
	if err != nil {
		return Manifest{}, "", problem(400, "invalid-skill", "技能包根目录缺少有效的 SKILL.md")
	}
	manifest, err := parseManifest(raw)
	if err != nil {
		return manifest, "", err
	}
	sort.Slice(b.files, func(i, j int) bool { return b.files[i].Path < b.files[j].Path })
	hash := sha256.New()
	dirs := map[string]bool{destination: true}
	for _, file := range b.files {
		fmt.Fprintf(hash, "%d:%s:%d:%s\n", len(file.Path), file.Path, file.Size, file.Digest)
		for dir := filepath.Dir(filepath.Join(destination, filepath.FromSlash(file.Path))); strings.HasPrefix(dir, destination); dir = filepath.Dir(dir) {
			dirs[dir] = true
			if dir == destination {
				break
			}
		}
	}
	// 包发布前同步所有目录项，避免配置已持久化而嵌套文件在崩溃后丢失。
	for name := range dirs {
		dir, err := openDirectory(name, false)
		if err != nil {
			return Manifest{}, "", err
		}
		err = dir.Sync()
		dir.Close()
		if err != nil {
			return Manifest{}, "", storageError()
		}
	}
	return manifest, hex.EncodeToString(hash.Sum(nil)), nil
}
