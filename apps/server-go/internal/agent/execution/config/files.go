package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const maxDocumentBytes = 8 << 20

type document struct {
	Schema   int       `json:"schema"`
	Profiles []Profile `json:"profiles"`
	Grants   []Grant   `json:"grants"`
}

func portString(port int) string { return strconv.Itoa(port) }

func openDirectory(path string, create bool) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, problem(400, "execution_invalid_path", "执行配置路径必须是规范的绝对路径")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if path != "/" {
		for _, component := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
			next, openErr := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if openErr == unix.ENOENT && create {
				if mkdirErr := unix.Mkdirat(fd, component, 0o700); mkdirErr != nil && mkdirErr != unix.EEXIST {
					unix.Close(fd)
					return nil, mkdirErr
				}
				next, openErr = unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
			unix.Close(fd)
			if openErr != nil {
				return nil, openErr
			}
			fd = next
		}
	}
	if create {
		if err = unix.Fchmod(fd, 0o700); err != nil {
			unix.Close(fd)
			return nil, err
		}
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openFile(dir *os.File, name string, flags int) (*os.File, error) {
	fd, err := unix.Openat(int(dir.Fd()), name, flags|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	var info unix.Stat_t
	if err = unix.Fstat(fd, &info); err != nil {
		f.Close()
		return nil, err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFREG || info.Nlink != 1 || info.Mode&0o777 != 0o600 || info.Uid != uint32(os.Geteuid()) {
		f.Close()
		return nil, problem(409, "execution_unsafe_config_file", "执行配置只能使用当前用户拥有的独立 0600 普通文件")
	}
	return f, nil
}

func randomID(prefix string) (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(raw[:]), nil
}

func (s *Store) read() (document, error) {
	f, err := openFile(s.dir, s.name, unix.O_RDONLY)
	if errors.Is(err, unix.ENOENT) {
		return document{Schema: 1, Profiles: []Profile{}, Grants: []Grant{}}, nil
	}
	if err != nil {
		return document{}, storageError(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxDocumentBytes+1))
	if err != nil || len(data) > maxDocumentBytes {
		return document{}, storageError(err)
	}
	var result document
	if err = json.Unmarshal(data, &result); err != nil || result.Schema != 1 || result.Profiles == nil || result.Grants == nil {
		return document{}, problem(503, "execution_config_invalid", "执行配置文件格式无效")
	}
	profileRevisions := map[string]int{}
	grantRevisions := map[string]int{}
	for _, p := range result.Profiles {
		if !idPattern.MatchString(p.ID) || !strings.HasPrefix(p.ID, "profile-") || p.Revision != profileRevisions[p.ID]+1 || ValidateProfile(p) != nil {
			return document{}, problem(503, "execution_config_invalid", "执行环境配置修订或字段无效")
		}
		profileRevisions[p.ID] = p.Revision
	}
	for _, g := range result.Grants {
		if !idPattern.MatchString(g.ID) || !strings.HasPrefix(g.ID, "grant-") || g.Revision != grantRevisions[g.ID]+1 || validateGrantShape(g, s.mountRoot) != nil {
			return document{}, problem(503, "execution_config_invalid", "执行授权配置修订或字段无效")
		}
		grantRevisions[g.ID] = g.Revision
	}
	return result, nil
}

func (s *Store) write(data document) error {
	encoded, err := json.Marshal(data)
	if err != nil || len(encoded) > maxDocumentBytes {
		return problem(413, "execution_config_limit", "执行配置与历史修订达到存储上限")
	}
	temp, err := randomID(".execution-")
	if err != nil {
		return storageError(err)
	}
	f, err := openFile(s.dir, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL)
	if err != nil {
		return storageError(err)
	}
	defer func() { f.Close(); unix.Unlinkat(int(s.dir.Fd()), temp, 0) }()
	if _, err = f.Write(encoded); err != nil {
		return storageError(err)
	}
	if err = f.Sync(); err != nil {
		return storageError(err)
	}
	if err = f.Close(); err != nil {
		return storageError(err)
	}
	if s.beforePublish != nil {
		if err = s.beforePublish(); err != nil {
			return storageError(err)
		}
	}
	if err = unix.Renameat(int(s.dir.Fd()), temp, int(s.dir.Fd()), s.name); err != nil {
		return storageError(err)
	}
	if err = s.dir.Sync(); err != nil {
		return &Error{Status: 500, Code: "execution_config_unconfirmed", Message: "执行配置已写入，但持久化结果尚未确认，请重新读取", cause: err}
	}
	return nil
}
