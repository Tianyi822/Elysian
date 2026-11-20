// Package tasklog 提供文件日志的追加和字节偏移分页，不持有任务状态或写入锁。
package tasklog

import (
	"bufio"
	"io"
	"os"
	"strings"
)

type LineMode uint8

const (
	RawLines      LineMode = iota // 保留换行和窗口末尾的半行。
	CompleteLines                 // 去掉换行，末尾半行回退，超窗单行分段返回。
)

type Page struct {
	Lines []string `json:"lines"`
	Next  int64    `json:"next"`
	Total int64    `json:"total"`
}

// ReadPage 从已校验的字节偏移读取窗口；没有文件时保留传入偏移。
func ReadPage(path string, offset, windowBytes int64, mode LineMode) (Page, error) {
	page := Page{Lines: []string{}, Next: offset}
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return page, nil
	}
	if err != nil {
		return Page{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Page{}, err
	}
	page.Total = info.Size()
	offset = min(offset, page.Total)
	page.Next = offset
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return Page{}, err
	}
	reader := bufio.NewReader(io.LimitReader(file, windowBytes))
	for {
		raw, readErr := reader.ReadString('\n')
		if raw != "" {
			page.Next += int64(len(raw))
			line := raw
			if mode == CompleteLines {
				if !strings.HasSuffix(raw, "\n") && (len(page.Lines) > 0 || page.Next-offset < windowBytes) {
					// 完整行后的半行或未读满窗口的半行留待下次；整窗单行须前进。
					page.Next -= int64(len(raw))
					break
				}
				line = strings.TrimSuffix(strings.TrimSuffix(raw, "\n"), "\r")
			}
			page.Lines = append(page.Lines, line)
		}
		if readErr != nil {
			break
		}
	}
	return page, nil
}

// OpenAppend 打开流式追加句柄，不创建父目录。
func OpenAppend(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

// Append 追加现成文本。正上限按当前文件字节截断；零表示由调用方决定额度。
func Append(path, text string, maxBytes int64) error {
	file, err := OpenAppend(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if maxBytes > 0 {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		remaining := maxBytes - info.Size()
		if remaining <= 0 {
			return nil
		}
		text = text[:min(int64(len(text)), remaining)]
	}
	_, err = file.WriteString(text)
	return err
}
