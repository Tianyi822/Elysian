package database

import (
	"encoding/json"
	"errors"
	"os"
	"sync"

	"elysian/server/internal/shared"
)

// 服务型数据库登记（~/.Elysian/config/databases.json）：文件与内存两实现。
// 文件实现每次 update 都走「读 → 变更 → 原子写」，全部操作经进程内互斥串行
//（TS 版的 tail promise 串行化等价物）；读时 O_NOFOLLOW + 身份校验，绝不向
// 浏览器透传文件原始内容。

// databaseRegistry 登记表接口。
type databaseRegistry interface {
	list() ([]databaseRecord, error)
	put(record databaseRecord) error
	remove(id string) error
}

// registrySizeLimit 登记文件 1 MiB 上限。
const registrySizeLimit = 1024 * 1024

// fileDatabaseRegistry 文件实现。
type fileDatabaseRegistry struct {
	path string
	mu   sync.Mutex
}

// newFileDatabaseRegistry 以指定路径构造文件登记表。
func newFileDatabaseRegistry(path string) *fileDatabaseRegistry {
	return &fileDatabaseRegistry{path: path}
}

// read 读取并校验登记文件；ENOENT 视为空表。
func (r *fileDatabaseRegistry) read() ([]databaseRecord, error) {
	f, err := openNoFollow(r.path)
	if err != nil {
		if isNoEntry(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > registrySizeLimit ||
		info.Mode()&0o077 != 0 || uidOf(info) != os.Getuid() {
		return nil, errors.New("数据库登记文件权限或内容无效")
	}
	var rows []databaseRecord
	if err := json.NewDecoder(f).Decode(&rows); err != nil {
		return nil, errors.New("数据库登记文件无效")
	}
	if rows == nil {
		return nil, errors.New("数据库登记文件无效")
	}
	return rows, nil
}

// write 原子替换登记文件。
func (r *fileDatabaseRegistry) write(rows []databaseRecord) error {
	data, err := shared.MarshalJSON(rows)
	if err != nil {
		return err
	}
	return writeFileAtomic(r.path, data)
}

// update 串行化读改写。
func (r *fileDatabaseRegistry) update(change func(rows []databaseRecord) ([]databaseRecord, error)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows, err := r.read()
	if err != nil {
		return err
	}
	next, err := change(rows)
	if err != nil {
		return err
	}
	return r.write(next)
}

func (r *fileDatabaseRegistry) list() ([]databaseRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.read()
}

func (r *fileDatabaseRegistry) put(record databaseRecord) error {
	return r.update(func(rows []databaseRecord) ([]databaseRecord, error) {
		next := make([]databaseRecord, 0, len(rows)+1)
		for _, row := range rows {
			if row.ID != record.ID {
				next = append(next, row)
			}
		}
		return append(next, record), nil
	})
}

func (r *fileDatabaseRegistry) remove(id string) error {
	return r.update(func(rows []databaseRecord) ([]databaseRecord, error) {
		next := make([]databaseRecord, 0, len(rows))
		for _, row := range rows {
			if row.ID != id {
				next = append(next, row)
			}
		}
		return next, nil
	})
}

// memoryDatabaseRegistry 内存实现（测试用）。
type memoryDatabaseRegistry struct {
	mu   sync.Mutex
	rows []databaseRecord
}

func newMemoryDatabaseRegistry(seed []databaseRecord) *memoryDatabaseRegistry {
	rows := make([]databaseRecord, len(seed))
	copy(rows, seed)
	return &memoryDatabaseRegistry{rows: rows}
}

func (r *memoryDatabaseRegistry) list() ([]databaseRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := make([]databaseRecord, len(r.rows))
	copy(rows, r.rows)
	return rows, nil
}

func (r *memoryDatabaseRegistry) put(record databaseRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make([]databaseRecord, 0, len(r.rows)+1)
	for _, row := range r.rows {
		if row.ID != record.ID {
			next = append(next, row)
		}
	}
	r.rows = append(next, record)
	return nil
}

func (r *memoryDatabaseRegistry) remove(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	next := make([]databaseRecord, 0, len(r.rows))
	for _, row := range r.rows {
		if row.ID != id {
			next = append(next, row)
		}
	}
	r.rows = next
	return nil
}
