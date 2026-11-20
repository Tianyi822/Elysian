// Package atomicfile 提供同目录原子替换，不处理各域的锁、文件形状或业务回执。
package atomicfile

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type WriteOptions struct {
	CreateParent bool
	DirSync      bool
	TempPattern  string        // CreateTemp 的同目录模式，随后显式设置 0600。
	TempSuffix   func() string // 非空时改用 path+suffix，独占创建且保留 umask。
}

type JSONOptions struct {
	WriteOptions
	Indent          string
	TrailingNewline bool
}

// WriteJSON 用 Go JSON 的转义规则编码，在触碰文件系统前完成序列化。
func WriteJSON(path string, value any, opts JSONOptions) error {
	var data []byte
	var err error
	if opts.Indent == "" {
		data, err = json.Marshal(value)
	} else {
		data, err = json.MarshalIndent(value, "", opts.Indent)
	}
	if err != nil {
		return err
	}
	if opts.TrailingNewline {
		data = append(data, '\n')
	}
	return WriteFile(path, data, opts.WriteOptions)
}

// WriteFile 同步暂存内容后替换目标。目标若是链接，rename 替换链接本身。
func WriteFile(path string, data []byte, opts WriteOptions) error {
	dir := filepath.Dir(path)
	if opts.CreateParent {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	file, err := openTemporary(path, dir, opts)
	if err != nil {
		return err
	}
	if opts.TempSuffix == nil {
		err = ReplaceTemp(path, file, data)
	} else {
		err = replace(path, file, data, false)
		if err != nil {
			_ = os.Remove(file.Name())
		}
	}
	if err != nil {
		return err
	}
	if opts.DirSync {
		return syncDirectory(dir, false)
	}
	return nil
}

// ReplaceTemp 接管调用方已在目标同目录独占创建的暂存文件，设为 0600，写入并
// 同步后关闭文件，再 rename。成功表示已经替换目标，不表示目录已经同步。
func ReplaceTemp(path string, file *os.File, data []byte) error {
	defer os.Remove(file.Name())
	return replace(path, file, data, true)
}

func replace(path string, file *os.File, data []byte, chmod bool) error {
	var err error
	if chmod {
		err = file.Chmod(0o600)
	}
	if err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func openTemporary(path, dir string, opts WriteOptions) (*os.File, error) {
	if opts.TempSuffix != nil {
		return os.OpenFile(path+opts.TempSuffix(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	return os.CreateTemp(dir, opts.TempPattern)
}

// SyncDirectory 同步目录；打开、同步或关闭失败均返回错误。
func SyncDirectory(dir string) error { return syncDirectory(dir, true) }

func syncDirectory(dir string, checkClose bool) error {
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = parent.Sync()
	if closeErr := parent.Close(); checkClose && err == nil {
		err = closeErr
	}
	return err
}
