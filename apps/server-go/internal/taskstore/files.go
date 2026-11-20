// Package taskstore 提供每任务一个 JSON 文件的账本操作。
// 读取限制、写入格式、互斥、索引和状态迁移均由业务域决定。
package taskstore

import (
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Dir 是任务账本目录。调用方负责校验任务标识。
type Dir string

func (d Dir) Path(id string) string { return filepath.Join(string(d), id+".json") }

func (d Dir) Glob() ([]string, error) {
	return filepath.Glob(filepath.Join(string(d), "*.json"))
}

func (d Dir) Remove(id string) error { return os.Remove(d.Path(id)) }

// SaveAndPublish 成功写入后才发布任务。调用方持有原锁，并负责准备独立副本。
func SaveAndPublish[T any](d Dir, tasks map[string]T, id string, next T, write func(string, any) error) error {
	if err := write(d.Path(id), next); err != nil {
		return err
	}
	tasks[id] = next
	return nil
}

var uuidShape = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// ValidUUIDShape 保留构建与部署账本的历史字符形状，不要求标准 UUID 连字符位置。
func ValidUUIDShape(id string) bool { return uuidShape.MatchString(id) }

// RetentionDeadline 计算原有 30 天保留期。坏时间戳与等于截止时刻的处理仍由域决定。
func RetentionDeadline(createdAt string) (time.Time, error) {
	created, err := time.Parse(time.RFC3339, createdAt)
	return created.Add(30 * 24 * time.Hour), err
}
