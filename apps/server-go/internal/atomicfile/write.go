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
	name := file.Name()
	if opts.TempSuffix == nil {
		defer os.Remove(name)
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
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		if opts.TempSuffix != nil {
			_ = os.Remove(name)
		}
		return err
	}
	if opts.DirSync {
		parent, err := os.Open(dir)
		if err != nil {
			return err
		}
		defer parent.Close()
		return parent.Sync()
	}
	return nil
}

func openTemporary(path, dir string, opts WriteOptions) (*os.File, error) {
	if opts.TempSuffix != nil {
		return os.OpenFile(path+opts.TempSuffix(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	}
	return os.CreateTemp(dir, opts.TempPattern)
}
