package containerapps

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"elysian/server/internal/shared"
)

const (
	// maxFileBytes 单文件上限：工作区放的是 compose/.env/配置文本，不是镜像产物。
	maxFileBytes int64 = 32 << 20
	// maxWorkspaceBytes 单个工作区累计上限。
	maxWorkspaceBytes int64 = 128 << 20
	// maxTextBytes 可编辑文本文件上限：超过它编辑器读出来也没法看。
	maxTextBytes int64 = 1 << 20
	// maxFileCount 单个工作区文件数上限。
	maxFileCount = 512
)

// FileEntry 工作区里的一个文件（清单由扫目录得出，不另存一份事实）。
type FileEntry struct {
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
	Text       bool   `json:"text"`
}

// ListFiles 扫描工作区目录，返回相对路径升序的文件清单。
func ListFiles(workspaceDir string) ([]FileEntry, error) {
	var files []FileEntry
	err := filepath.Walk(workspaceDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			// 目录本身不进清单；符号链接目录不跟随，避免绕出工作区。
			if info.Mode()&os.ModeSymlink != 0 {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(workspaceDir, path)
		if relErr != nil {
			return relErr
		}
		files = append(files, FileEntry{
			Path:       filepath.ToSlash(rel),
			Size:       info.Size(),
			ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
			Text:       info.Size() <= maxTextBytes && looksTextual(path),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// looksTextual 采样判断是否文本：读前 8 KiB，出现 NUL 即二进制，非法 UTF-8 也算二进制。
// 内容编辑只服务文本，判错方向的代价是用户看到一屏乱码，所以宁可拒。
func looksTextual(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	buf := make([]byte, 8192)
	n, err := f.Read(buf)
	if err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	return textualPrefix(buf[:n])
}

// textualPrefix 对一段字节做文本判定（纯函数，便于测试）。
func textualPrefix(sample []byte) bool {
	if bytesIndexByte(sample, 0) >= 0 {
		return false
	}
	return utf8.Valid(sample)
}

func bytesIndexByte(sample []byte, target byte) int {
	for i, b := range sample {
		if b == target {
			return i
		}
	}
	return -1
}

// workspaceUsed 累计工作区已用字节，用于配额判定。
func workspaceUsed(workspaceDir string) (int64, error) {
	var total int64
	err := filepath.Walk(workspaceDir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// Upload 写入一个文件。目标已存在时整体覆盖（配置文件的常态就是反复改）。
//
// 落盘手法沿用面板既有做法：先写 <target>.upload 临时文件（O_CREATE|O_EXCL、0600）、
// 边读边计数字节、超限即断，Sync 后按「已用量（覆盖场景扣除旧文件）+ 临时文件字节」
// 判工作区配额，超限在 rename 之前拒绝并清掉临时文件，再 rename 提升到位。申报长度
// 与实读长度不符也拒绝，避免截断文件被当成新版本。
func Upload(workspaceDir, rel string, body io.Reader, declaredLength int64) (FileEntry, error) {
	target, err := resolveWithinWorkspace(workspaceDir, rel)
	if err != nil {
		return FileEntry{}, err
	}
	if declaredLength > maxFileBytes {
		return FileEntry{}, &TooLargeError{Limit: maxFileBytes}
	}
	used, err := workspaceUsed(workspaceDir)
	if err != nil {
		return FileEntry{}, err
	}
	info, statErr := os.Stat(target)
	replacing := statErr == nil
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return FileEntry{}, statErr
	}
	if replacing && info.Size() > maxFileBytes {
		return FileEntry{}, &TooLargeError{Limit: maxFileBytes}
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return FileEntry{}, err
	}
	// 临时文件名带上目标名的后缀，同目录内 rename 才是原子的。
	temp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".upload-*")
	if err != nil {
		return FileEntry{}, err
	}
	tempName := temp.Name()
	cleanup := func() { temp.Close(); _ = os.Remove(tempName) }

	written, copyErr := io.Copy(temp, io.LimitReader(body, maxFileBytes+1))
	if copyErr == nil && written > maxFileBytes {
		copyErr = &TooLargeError{Limit: maxFileBytes}
	}
	if copyErr == nil && declaredLength >= 0 && written != declaredLength {
		copyErr = shared.InvalidRequest("上传字节数与申报长度不符，请重新上传")
	}
	if copyErr == nil {
		copyErr = temp.Chmod(0600)
	}
	if copyErr == nil {
		copyErr = temp.Sync()
	}
	closeErr := temp.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		// 配额判定在 rename 之前：超限直接清临时文件返回 413，不把超额内容落盘。
		// 覆盖场景按「已用量扣除将被替换的旧文件」计算基线。
		var tempInfo os.FileInfo
		tempInfo, copyErr = os.Stat(tempName)
		if copyErr == nil {
			baseline := used
			if replacing {
				baseline -= info.Size()
			}
			if baseline+tempInfo.Size() > maxWorkspaceBytes {
				cleanup()
				return FileEntry{}, &TooLargeError{Limit: maxWorkspaceBytes}
			}
		}
	}
	if copyErr == nil {
		if err = os.Rename(tempName, target); err != nil {
			copyErr = err
		}
	} else {
		cleanup()
	}
	if copyErr != nil {
		return FileEntry{}, copyErr
	}
	final, err := os.Stat(target)
	if err != nil {
		return FileEntry{}, err
	}
	return FileEntry{
		Path:       filepath.ToSlash(mustRel(workspaceDir, target)),
		Size:       final.Size(),
		ModifiedAt: final.ModTime().UTC().Format(time.RFC3339),
		Text:       looksTextual(target),
	}, nil
}

func mustRel(workspaceDir, target string) string {
	rel, err := filepath.Rel(workspaceDir, target)
	if err != nil {
		return filepath.Base(target)
	}
	return rel
}

// ReadContent 读出文本文件全文。二进制或超限一律拒绝，不返回半截内容。
func ReadContent(workspaceDir, rel string) (string, FileEntry, error) {
	target, err := resolveWithinWorkspace(workspaceDir, rel)
	if err != nil {
		return "", FileEntry{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", FileEntry{}, &FileNotFoundError{Path: rel}
		}
		return "", FileEntry{}, err
	}
	if !info.Mode().IsRegular() {
		return "", FileEntry{}, shared.InvalidRequest("只能读取普通文件")
	}
	if info.Size() > maxTextBytes {
		return "", FileEntry{}, &TooLargeError{Limit: maxTextBytes}
	}
	b, err := os.ReadFile(target)
	if err != nil {
		return "", FileEntry{}, err
	}
	if !textualPrefix(b) {
		return "", FileEntry{}, shared.InvalidRequest("该文件不是 UTF-8 文本，面板内不提供编辑")
	}
	return string(b), FileEntry{
		Path:       filepath.ToSlash(mustRel(workspaceDir, target)),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		Text:       true,
	}, nil
}

// WriteContent 覆盖写一个文本文件。写前校验 UTF-8 且不含 NUL，避免把二进制塞进配置。
func WriteContent(workspaceDir, rel, content string) (FileEntry, error) {
	if int64(len(content)) > maxTextBytes {
		return FileEntry{}, &TooLargeError{Limit: maxTextBytes}
	}
	if strings.IndexByte(content, 0) >= 0 || !utf8.ValidString(content) {
		return FileEntry{}, shared.InvalidRequest("编辑内容必须是 UTF-8 文本且不含空字符")
	}
	target, err := resolveWithinWorkspace(workspaceDir, rel)
	if err != nil {
		return FileEntry{}, err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return FileEntry{}, err
	}
	temp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".edit-*")
	if err != nil {
		return FileEntry{}, err
	}
	tempName := temp.Name()
	if _, err = temp.WriteString(content); err == nil {
		err = temp.Chmod(0600)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tempName, target)
	}
	if err != nil {
		_ = os.Remove(tempName)
		return FileEntry{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return FileEntry{}, err
	}
	return FileEntry{
		Path:       filepath.ToSlash(mustRel(workspaceDir, target)),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339),
		Text:       true,
	}, nil
}

// DeleteFile 删除工作区内的一个文件。
func DeleteFile(workspaceDir, rel string) error {
	target, err := resolveWithinWorkspace(workspaceDir, rel)
	if err != nil {
		return err
	}
	if err = os.Remove(target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &FileNotFoundError{Path: rel}
		}
		return err
	}
	return nil
}

// TooLargeError 超限；路由映射 413。
type TooLargeError struct{ Limit int64 }

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *TooLargeError) Error() string {
	return fmt.Sprintf("超过大小上限 %d MiB", e.Limit>>20)
}

// ContentTypeError 上传的 Content-Type 不符；路由映射 415。
type ContentTypeError struct{ Got string }

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *ContentTypeError) Error() string {
	return "上传内容类型必须为 application/octet-stream"
}

// ContentType 取请求的 Content-Type 主类型（去参数）。
func ContentType(r *http.Request) string {
	value := r.Header.Get("Content-Type")
	if index := strings.Index(value, ";"); index >= 0 {
		value = value[:index]
	}
	return strings.ToLower(strings.TrimSpace(value))
}

// FileNotFoundError 工作区内文件不存在；路由映射 404。
type FileNotFoundError struct{ Path string }

// Error 实现 error；消息是 API 契约（中文，逐字）。
func (e *FileNotFoundError) Error() string { return "工作区内没有该文件：" + e.Path }
