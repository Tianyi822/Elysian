package docker

import (
	"bytes"
	"errors"
)

// 拉取进度按行解码（dockerStreams.ts 逐字移植）：跨块 JSON 行不丢帧、error 行带
// 原文失败、64 MiB 总量与 128 KiB 单行上限、流式解码器按 phase:layerId:百分比去重。

const (
	maxPullProgressBytes = 64 * 1024 * 1024
	maxPullLineLength    = 128 * 1024
)

// imagePullProgress 对应契约 ImagePullProgress；字节字段用指针保留 0 与缺省的区分。
type imagePullProgress struct {
	Phase        string   `json:"phase"`
	Message      string   `json:"message,omitempty"`
	LayerID      string   `json:"layerId,omitempty"`
	CurrentBytes *float64 `json:"currentBytes,omitempty"`
	TotalBytes   *float64 `json:"totalBytes,omitempty"`
}

// pullErrorFromLine 从进度行提取错误消息；无错误返回空串。
func pullErrorFromLine(line string) string {
	if len(line) == 0 {
		return ""
	}
	value, err := decodeOrderedJSON([]byte(line))
	if err != nil {
		return ""
	}
	frame, ok := asRecord(value)
	if !ok {
		return ""
	}
	message := ""
	if detail, ok := asRecord(mustGet(frame, "errorDetail")); ok {
		if m, ok := asString(mustGet(detail, "message")); ok {
			message = m
		}
	}
	if message == "" {
		if m, ok := asString(mustGet(frame, "error")); ok {
			message = m
		}
	}
	if message == "" {
		return ""
	}
	return message
}

// progressFromLine 解析单行进度；非进度行返回 false。
func progressFromLine(line string) (imagePullProgress, bool) {
	value, err := decodeOrderedJSON([]byte(line))
	if err != nil {
		return imagePullProgress{}, false
	}
	frame, ok := asRecord(value)
	if !ok {
		return imagePullProgress{}, false
	}
	status, ok := asString(mustGet(frame, "status"))
	if !ok {
		return imagePullProgress{}, false
	}

	var phase string
	switch {
	case status == "Downloading":
		phase = "downloading"
	case status == "Extracting":
		phase = "extracting"
	case status == "Pulling fs layer" || status == "Waiting" || hasPrefixStr(status, "Pulling from "):
		phase = "preparing"
	default:
		phase = "finalizing"
	}

	progress := imagePullProgress{Phase: phase}
	if layerID, ok := asString(mustGet(frame, "id")); ok && len(layerID) <= 64 && !hasPrefixStr(status, "Pulling from ") {
		progress.LayerID = layerID
	}

	hasBytes := false
	var current, total float64
	if phase == "downloading" || phase == "extracting" {
		if detail, ok := asRecord(mustGet(frame, "progressDetail")); ok {
			c, okC := asNumber(mustGet(detail, "current"))
			t, okT := asNumber(mustGet(detail, "total"))
			if okC && okT && isFiniteNumber(c) && c >= 0 && isFiniteNumber(t) && t > 0 {
				current, total, hasBytes = c, t, true
			}
		}
	}
	if hasBytes {
		min := current
		if total < min {
			min = total
		}
		progress.CurrentBytes = &min
		progress.TotalBytes = &total
	}
	return progress, true
}

func hasPrefixStr(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// pullProgressDecoder 流式解码器：feed 逐块喂入，同 phase:layerId:整数百分比 的
// 进度帧只推一次；finish 冲洗尾部残行。
type pullProgressDecoder struct {
	onProgress func(imagePullProgress)
	buffer     []byte
	lastKey    string
}

func newPullProgressDecoder(onProgress func(imagePullProgress)) *pullProgressDecoder {
	return &pullProgressDecoder{onProgress: onProgress}
}

func (d *pullProgressDecoder) consume(line string) error {
	if hasSuffixByte(line, '\r') {
		line = line[:len(line)-1]
	}
	if message := pullErrorFromLine(line); message != "" {
		return errors.New(message)
	}
	progress, ok := progressFromLine(line)
	if !ok {
		return nil
	}
	percent := "unknown"
	if progress.TotalBytes != nil && *progress.TotalBytes > 0 {
		current := float64(0)
		if progress.CurrentBytes != nil {
			current = *progress.CurrentBytes
		}
		percent = itoa(int(int64Floor(current / *progress.TotalBytes * 100)))
	}
	key := progress.Phase + ":" + progress.LayerID + ":" + percent
	if key == d.lastKey {
		return nil
	}
	d.lastKey = key
	if d.onProgress != nil {
		d.onProgress(progress)
	}
	return nil
}

func int64Floor(f float64) int64 {
	if f < 0 {
		return 0
	}
	return int64(f)
}

func hasSuffixByte(s string, b byte) bool {
	return len(s) > 0 && s[len(s)-1] == b
}

// feed 喂入一个原始块；行超限或出现错误行时返回错误。
func (d *pullProgressDecoder) feed(chunk []byte) error {
	d.buffer = append(d.buffer, chunk...)
	for {
		newline := bytes.IndexByte(d.buffer, '\n')
		if newline == -1 {
			break
		}
		line := string(d.buffer[:newline])
		d.buffer = d.buffer[newline+1:]
		if len(line) > maxPullLineLength {
			return errors.New("拉取进度行过大")
		}
		if err := d.consume(line); err != nil {
			return err
		}
	}
	if len(d.buffer) > maxPullLineLength {
		return errors.New("拉取进度行过大")
	}
	return nil
}

// finish 冲洗未换行的尾部残行。
func (d *pullProgressDecoder) finish() error {
	if len(d.buffer) > 0 {
		rest := string(d.buffer)
		d.buffer = nil
		return d.consume(rest)
	}
	return nil
}

// readPullProgress 对完整响应体复查错误行与总量上限；返回首个错误行消息。
func readPullProgress(body []byte) error {
	if len(body) > maxPullProgressBytes {
		return errors.New("拉取进度过大")
	}
	textBuffer := body
	for {
		newline := bytes.IndexByte(textBuffer, '\n')
		if newline == -1 {
			break
		}
		line := string(textBuffer[:newline])
		textBuffer = textBuffer[newline+1:]
		if hasSuffixByte(line, '\r') {
			line = line[:len(line)-1]
		}
		if message := pullErrorFromLine(line); message != "" {
			return errors.New(message)
		}
	}
	if len(textBuffer) > 0 {
		line := string(textBuffer)
		if hasSuffixByte(line, '\r') {
			line = line[:len(line)-1]
		}
		if message := pullErrorFromLine(line); message != "" {
			return errors.New(message)
		}
	}
	return nil
}

// lineSplitter 通用按行切分器（Engine events 流用）：跨块拼行、剥 \r、空行不下发。
type lineSplitter struct {
	onLine func(line string)
	buffer []byte
}

func newLineSplitter(onLine func(line string)) *lineSplitter {
	return &lineSplitter{onLine: onLine}
}

func (l *lineSplitter) feed(chunk []byte) {
	l.buffer = append(l.buffer, chunk...)
	for {
		newline := bytes.IndexByte(l.buffer, '\n')
		if newline == -1 {
			break
		}
		line := l.buffer[:newline]
		l.buffer = l.buffer[newline+1:]
		if len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if len(line) > 0 {
			l.onLine(string(line))
		}
	}
}

// flush 下发未换行的尾部（流结束时）。
func (l *lineSplitter) flush() {
	if len(l.buffer) > 0 {
		line := l.buffer
		l.buffer = nil
		if line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}
		if len(line) > 0 {
			l.onLine(string(line))
		}
	}
}
