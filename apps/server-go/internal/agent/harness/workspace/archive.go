package workspace

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const manifestName = ".elysian-workspace.json"

type archiveEntry struct {
	File
	file   *os.File
	offset int64
}

func (e archiveEntry) reader() io.Reader { return io.NewSectionReader(e.file, e.offset, e.Size) }

type loadedVersion struct {
	version Version
	entries []archiveEntry
	file    *os.File
}

func (l *loadedVersion) close() {
	if l.file != nil {
		l.file.Close()
	}
}
func (l *loadedVersion) snapshot() Snapshot {
	result := Snapshot{Version: l.version, Files: make([]File, 0, len(l.entries))}
	for _, entry := range l.entries {
		result.Files = append(result.Files, entry.File)
	}
	return result
}

func describe(taskID string, revision, baseRevision int, entries []archiveEntry) Version {
	v := Version{TaskID: taskID, Revision: revision, BaseRevision: baseRevision, FileCount: len(entries)}
	h := sha256.New()
	for _, entry := range entries {
		v.Bytes += entry.Size
		// JSON 编码使路径中的分隔字符不能混淆摘要边界。
		encoded, _ := json.Marshal(entry.File)
		h.Write(encoded)
		h.Write([]byte{'\n'})
	}
	v.Digest = hex.EncodeToString(h.Sum(nil))
	return v
}

func (s *Store) load(ctx context.Context, taskID string, revision int) (*loadedVersion, error) {
	if revision == 0 {
		return &loadedVersion{version: describe(taskID, 0, 0, nil)}, nil
	}
	f, err := safeFileAt(s.root, archiveName(taskID, revision), unix.O_RDONLY)
	if errors.Is(err, unix.ENOENT) {
		return nil, problem(409, "workspace_revision_not_found", "工作区基础版本不存在或已清理")
	}
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*loadedVersion, error) { f.Close(); return nil, err }
	info, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if info.Size() > s.limits.GlobalBytes {
		return fail(quotaError("工作区归档超过总存储上限"))
	}
	tr := tar.NewReader(&contextReader{ctx: ctx, r: f})
	header, err := tr.Next()
	if err != nil || header.Name != manifestName || header.Typeflag != tar.TypeReg || header.Size > 4096 {
		return fail(problem(409, "workspace_corrupt_archive", "工作区版本元数据损坏"))
	}
	metadata, err := io.ReadAll(tr)
	if err != nil {
		return fail(err)
	}
	var version Version
	if err = json.Unmarshal(metadata, &version); err != nil || version.TaskID != taskID || version.Revision != revision || version.BaseRevision < 0 || version.BaseRevision >= revision {
		return fail(problem(409, "workspace_corrupt_archive", "工作区版本元数据无效"))
	}
	entries, err := scanArchive(ctx, tr, f, s.limits, false)
	if err != nil {
		return fail(err)
	}
	actual := describe(taskID, revision, version.BaseRevision, entries)
	if actual != version {
		return fail(problem(409, "workspace_corrupt_archive", "工作区内容与版本摘要不一致"))
	}
	return &loadedVersion{version: version, entries: entries, file: f}, nil
}

func readExternalArchive(ctx context.Context, f *os.File, limits Limits) ([]archiveEntry, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() < 1024 || info.Size()%512 != 0 {
		return nil, problem(400, "workspace_invalid_archive", "工作区 TAR 归档缺少完整结束标记")
	}
	var ending [1024]byte
	if _, err = f.ReadAt(ending[:], info.Size()-1024); err != nil {
		return nil, err
	}
	for _, b := range ending {
		if b != 0 {
			return nil, problem(400, "workspace_invalid_archive", "工作区 TAR 归档缺少完整结束标记")
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return scanArchive(ctx, tar.NewReader(&contextReader{ctx: ctx, r: f}), f, limits, true)
}

func scanArchive(ctx context.Context, tr *tar.Reader, f *os.File, limits Limits, external bool) ([]archiveEntry, error) {
	entries := make([]archiveEntry, 0)
	seen := make(map[string]bool)
	dirs := make(map[string]bool)
	var size int64
	count := 0
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, problem(400, "workspace_invalid_archive", "工作区 TAR 归档无效或内容不完整")
		}
		count++
		if count > limits.TaskFiles*33 {
			return nil, quotaError("工作区归档条目数量超过上限")
		}
		name := header.Name
		isDir := header.Typeflag == tar.TypeDir
		if isDir {
			name = strings.TrimSuffix(name, "/")
		}
		if err = validatePath(name); err != nil {
			return nil, err
		}
		if name == manifestName {
			return nil, problem(400, "workspace_reserved_path", "工作区路径是保留的元数据名称")
		}
		if header.Linkname != "" || (!isDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) {
			return nil, problem(400, "workspace_unsafe_archive", "工作区归档不允许链接、稀疏文件或特殊文件")
		}
		for key := range header.PAXRecords {
			if strings.HasPrefix(key, "GNU.sparse") || strings.HasPrefix(key, "SCHILY.") {
				return nil, problem(400, "workspace_unsafe_archive", "工作区归档包含不支持的扩展元数据")
			}
		}
		if seen[name] || dirs[name] {
			return nil, problem(400, "workspace_duplicate_path", "工作区归档包含重复路径")
		}
		if isDir {
			if !external || header.Size != 0 {
				return nil, problem(400, "workspace_invalid_archive", "工作区目录条目无效")
			}
			dirs[name] = true
			continue
		}
		seen[name] = true
		if len(entries) >= limits.TaskFiles || header.Size < 0 || header.Size > limits.TaskBytes-size {
			return nil, quotaError("工作区文件数量或展开内容超过上限")
		}
		offset, err := f.Seek(0, io.SeekCurrent)
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		written, err := io.Copy(h, tr)
		if err != nil || written != header.Size {
			return nil, problem(400, "workspace_invalid_archive", "工作区文件内容不完整")
		}
		entries = append(entries, archiveEntry{File: File{Path: name, Size: header.Size, Digest: hex.EncodeToString(h.Sum(nil))}, file: f, offset: offset})
		size += header.Size
	}
	// tar.Reader 在结束标记处停止；其后只能有零填充，防止隐藏的第二个归档。
	var tail [32768]byte
	for {
		n, err := f.Read(tail[:])
		for _, b := range tail[:n] {
			if b != 0 {
				return nil, problem(400, "workspace_invalid_archive", "工作区归档结束后含额外内容")
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if err = ctx.Err(); err != nil {
			return nil, err
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	if err := validateEntries(entries, limits); err != nil {
		return nil, err
	}
	for directory := range dirs {
		for name := directory; name != ""; name = parentPath(name) {
			if seen[name] {
				return nil, problem(400, "workspace_path_conflict", "工作区同一路径不能同时作为文件和目录")
			}
		}
	}
	return entries, nil
}

func parentPath(name string) string {
	i := strings.LastIndexByte(name, '/')
	if i < 0 {
		return ""
	}
	return name[:i]
}

func validateEntries(entries []archiveEntry, limits Limits) error {
	if len(entries) > limits.TaskFiles {
		return quotaError("工作区文件数量超过上限")
	}
	var bytes int64
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if err := validatePath(entry.Path); err != nil {
			return err
		}
		if entry.Path == manifestName {
			return problem(400, "workspace_reserved_path", "工作区路径是保留的元数据名称")
		}
		if seen[entry.Path] {
			return problem(400, "workspace_duplicate_path", "工作区包含重复路径")
		}
		for prefix := parentPath(entry.Path); prefix != ""; prefix = parentPath(prefix) {
			if seen[prefix] {
				return problem(400, "workspace_path_conflict", "工作区同一路径不能同时作为文件和目录")
			}
		}
		seen[entry.Path] = true
		if entry.Size < 0 || entry.Size > limits.TaskBytes-bytes {
			return quotaError("工作区展开内容超过上限")
		}
		bytes += entry.Size
	}
	return nil
}

func spoolFile(ctx context.Context, f *os.File, name string, r io.Reader, limit int64) (archiveEntry, error) {
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(&limitWriter{w: f, remaining: limit}, h), io.LimitReader(&contextReader{ctx: ctx, r: r}, limit+1))
	if err != nil {
		return archiveEntry{}, err
	}
	if n > limit {
		return archiveEntry{}, quotaError("工作区文件内容超过上限")
	}
	return archiveEntry{File: File{Path: name, Size: n, Digest: hex.EncodeToString(h.Sum(nil))}, file: f}, nil
}

func writeArchive(ctx context.Context, w io.Writer, entries []archiveEntry, version *Version) error {
	tw := tar.NewWriter(w)
	if version != nil {
		metadata, err := json.Marshal(version)
		if err != nil {
			return err
		}
		if err = tw.WriteHeader(headerFor(manifestName, int64(len(metadata)))); err != nil {
			return err
		}
		if _, err = tw.Write(metadata); err != nil {
			return err
		}
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := tw.WriteHeader(headerFor(entry.Path, entry.Size)); err != nil {
			return err
		}
		h := sha256.New()
		n, err := io.Copy(io.MultiWriter(tw, h), &contextReader{ctx: ctx, r: entry.reader()})
		if err != nil {
			return err
		}
		if n != entry.Size || !matchesDigest(h, entry.Digest) {
			return problem(409, "workspace_changed", "工作区文件在复制过程中发生变化")
		}
	}
	return tw.Close()
}

func headerFor(name string, size int64) *tar.Header {
	return &tar.Header{Name: name, Size: size, Mode: 0o600, Typeflag: tar.TypeReg, ModTime: time.Unix(0, 0), Format: tar.FormatPAX}
}

func matchesDigest(h hash.Hash, want string) bool { return fmt.Sprintf("%x", h.Sum(nil)) == want }
