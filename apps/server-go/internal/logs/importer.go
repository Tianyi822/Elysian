package logs

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

/*
 * 启动分片导入（logImport.ts 等价物）：把 ~/.Elysian/logs/platform/<类别>/ 下的
 * jsonl/jsonl.gz 分片导入 SQLite 后 unlink。目录读失败（含不存在）跳过该类别、
 * 从不创建目录；只接受现行分片命名，其余文件原样不动。
 */

// shardFilePattern 仅接受现行分片命名：类别-UTC 时间戳，可选 _2+ 后缀，可选 .gz。
var shardFilePattern = regexp.MustCompile(`^(runtime|operation|login)-\d{8}T\d{6}Z(_[2-9]\d*)?\.jsonl(\.gz)?$`)

// importCategories 导入类别次序。
var importCategories = []string{categoryRuntime, categoryOperation, categoryLogin}

// sha256Hex 整行原文（含行内空白）的 sha256 hex——去重键的唯一来源，不能先 trim。
func sha256Hex(line string) string {
	sum := sha256.Sum256([]byte(line))
	return hex.EncodeToString(sum[:])
}

// readShardText 读分片全文：.gz 用 gunzip 解出。
func readShardText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if filepath.Ext(path) != ".gz" {
		return string(data), nil
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	decompressed, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	if err := reader.Close(); err != nil {
		return "", err
	}
	return string(decompressed), nil
}

// ImportPlatformLogs 启动时导入平台日志目录下的分片：成功导入的 unlink；
// 读失败/事务失败/unlink 失败各自 console.error 且留下文件（永不向调用方抛错）。
func ImportPlatformLogs(store logStore, platformLogsDir string) {
	for _, category := range importCategories {
		dir := filepath.Join(platformLogsDir, category)
		names, err := os.ReadDir(dir)
		if err != nil {
			// 目录不存在或不可读：跳过该类别，不创建目录。
			continue
		}
		for _, entry := range names {
			name := entry.Name()
			if !shardFilePattern.MatchString(name) {
				continue
			}
			fullPath := filepath.Join(dir, name)
			text, err := readShardText(fullPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Elysian 日志导入读文件失败（%s）：%v\n", fullPath, err)
				continue
			}
			lines := strings.Split(text, "\n")
			if _, _, err := store.ImportFile(category, lines); err != nil {
				fmt.Fprintf(os.Stderr, "Elysian 日志导入事务失败（%s）：%v\n", fullPath, err)
				continue
			}
			if err := os.Remove(fullPath); err != nil {
				fmt.Fprintf(os.Stderr, "Elysian 日志导入删除分片失败（%s）：%v\n", fullPath, err)
			}
		}
	}
}
