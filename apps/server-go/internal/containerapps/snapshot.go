package containerapps

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

func validWorkspaceDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == value
}

// WorkspaceDigest binds approvals to bounded file contents and relative names.
func WorkspaceDigest(directory string) (string, error) {
	hash := sha256.New()
	files, bytes := 0, int64(0)
	err := walkContextFiles(directory, func(rel string, info os.FileInfo) error {
		files++
		bytes += info.Size()
		if files > maxContextFiles || bytes > maxContextBytes {
			return errors.New("工作区内容超过构建快照上限")
		}
		file, err := os.Open(filepath.Join(directory, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
			return errors.New("生成快照时文件身份发生变化")
		}
		_ = binary.Write(hash, binary.BigEndian, uint64(len(rel)))
		_, _ = io.WriteString(hash, rel)
		_ = binary.Write(hash, binary.BigEndian, uint64(info.Size()))
		written, err := io.Copy(hash, io.LimitReader(file, info.Size()+1))
		if err != nil {
			return err
		}
		after, err := file.Stat()
		if err != nil || written != info.Size() || after.Size() != info.Size() || after.ModTime() != info.ModTime() {
			return errors.New("生成快照时文件内容发生变化")
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
