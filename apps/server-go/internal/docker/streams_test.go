package docker

import (
	"strings"
	"testing"
)

// streams 对等测试（dockerStreams.test.ts 锚点）。

func TestPullErrorFromLine(t *testing.T) {
	if got := pullErrorFromLine(`{"error":"denied"}`); got != "denied" {
		t.Fatalf("error 行：%q", got)
	}
	if got := pullErrorFromLine(`{"errorDetail":{"message":"not found"}}`); got != "not found" {
		t.Fatalf("errorDetail.message 优先：%q", got)
	}
	if got := pullErrorFromLine(`{"status":"Downloading"}`); got != "" {
		t.Fatalf("进度行无错误：%q", got)
	}
	if got := pullErrorFromLine(""); got != "" {
		t.Fatalf("空行：%q", got)
	}
}

func TestReadPullProgressErrorLines(t *testing.T) {
	if err := readPullProgress([]byte(`{"status":"Pulling"}\n`)); err != nil {
		t.Fatalf("纯进度行应 ok：%v", err)
	}
	err := readPullProgress([]byte("{\"status\":\"Downloading\"}\n{\"error\":\"denied\"}\n"))
	if err == nil || err.Error() != "denied" {
		t.Fatalf("error 行应失败带原文：%v", err)
	}
	err = readPullProgress([]byte("{\"errorDetail\":{\"message\":\"boom\"}\"}"))
	_ = err
	// 坏 JSON 行不是错误行：整流仍 ok。
	if err := readPullProgress([]byte("not-json\n")); err != nil {
		t.Fatalf("坏 JSON 行按无错误处理：%v", err)
	}
	// 尾部无换行的 error 行也要捕捉。
	if err := readPullProgress([]byte(`{"error":"tail"}`)); err == nil || err.Error() != "tail" {
		t.Fatalf("尾部 error 行：%v", err)
	}
}

func TestReadPullProgressChunkBoundaries(t *testing.T) {
	line := `{"errorDetail":{"message":"split"}}` + "\n"
	// 模拟跨块：decoder 无关；readPullProgress 对整段字节处理。
	if err := readPullProgress([]byte(line[:10] + line[10:])); err == nil || err.Error() != "split" {
		t.Fatalf("跨块行应拼出错误：%v", err)
	}
}

func TestReadPullProgressTooLarge(t *testing.T) {
	if err := readPullProgress(make([]byte, maxPullProgressBytes+1)); err == nil || err.Error() != "拉取进度过大" {
		t.Fatalf("总量超限：%v", err)
	}
	if err := readPullProgress(make([]byte, maxPullProgressBytes)); err != nil {
		t.Fatalf("恰好 64MiB 应 ok：%v", err)
	}
}

func TestPullProgressDecoderAcrossChunks(t *testing.T) {
	var got []imagePullProgress
	decoder := newPullProgressDecoder(func(p imagePullProgress) { got = append(got, p) })
	line := `{"status":"Downloading","id":"abc","progressDetail":{"current":50,"total":100}}` + "\n"
	if err := decoder.feed([]byte(line[:19])); err != nil {
		t.Fatal(err)
	}
	if err := decoder.feed([]byte(line[19:])); err != nil {
		t.Fatal(err)
	}
	if err := decoder.finish(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("跨块应解出 1 帧：%d", len(got))
	}
	p := got[0]
	if p.Phase != "downloading" || p.LayerID != "abc" || *p.CurrentBytes != 50 || *p.TotalBytes != 100 {
		t.Fatalf("帧内容：%+v", p)
	}
}

func TestPullProgressDecoderPhases(t *testing.T) {
	cases := map[string]string{
		`{"status":"Downloading"}`:        "downloading",
		`{"status":"Extracting"}`:         "extracting",
		`{"status":"Pulling fs layer"}`:   "preparing",
		`{"status":"Waiting"}`:            "preparing",
		`{"status":"Pulling from x"}`:     "preparing",
		`{"status":"Download complete"}`:  "finalizing",
		`{"status":"Status: Downloaded"}`: "finalizing",
	}
	for line, want := range cases {
		var got []imagePullProgress
		decoder := newPullProgressDecoder(func(p imagePullProgress) { got = append(got, p) })
		if err := decoder.feed([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].Phase != want {
			t.Fatalf("%s → %+v，want %s", line, got, want)
		}
	}
}

func TestPullProgressDecoderDedupByPercent(t *testing.T) {
	var got []imagePullProgress
	decoder := newPullProgressDecoder(func(p imagePullProgress) { got = append(got, p) })
	feed := func(current int) {
		line := `{"status":"Downloading","id":"l","progressDetail":{"current":` + itoa(current) + `,"total":100}}` + "\n"
		if err := decoder.feed([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	feed(10)
	feed(20)
	feed(25)
	feed(26) // 同整数百分比 25 → 26 是不同 key？26 与 25 不同。
	feed(60)
	if len(got) != 5 {
		t.Fatalf("不同百分比各自推送：%d", len(got))
	}

	got = nil
	decoder = newPullProgressDecoder(func(p imagePullProgress) { got = append(got, p) })
	same := `{"status":"Downloading","id":"l","progressDetail":{"current":55,"total":100}}` + "\n"
	_ = decoder.feed([]byte(same))
	_ = decoder.feed([]byte(same))
	_ = decoder.feed([]byte(same))
	if len(got) != 1 {
		t.Fatalf("同整数百分比只推一次：%d", len(got))
	}
}

func TestPullProgressDecoderErrorFrame(t *testing.T) {
	var got []imagePullProgress
	decoder := newPullProgressDecoder(func(p imagePullProgress) { got = append(got, p) })
	err := decoder.feed([]byte("{\"status\":\"Downloading\"}\n{\"error\":\"denied\"}\n"))
	if err == nil || err.Error() != "denied" {
		t.Fatalf("错误帧立即返回：%v", err)
	}
}

func TestPullProgressDecoderLineTooLong(t *testing.T) {
	decoder := newPullProgressDecoder(func(imagePullProgress) {})
	long := strings.Repeat("a", maxPullLineLength+1)
	if err := decoder.feed([]byte(long + "\n")); err == nil || err.Error() != "拉取进度行过大" {
		t.Fatalf("行超限：%v", err)
	}
}

func TestLineSplitterAcrossChunks(t *testing.T) {
	var lines []string
	splitter := newLineSplitter(func(line string) { lines = append(lines, line) })
	splitter.feed([]byte("{\"a\":1}\r\n{\"b\""))
	splitter.feed([]byte(":2}\n\n{\"c\":3}"))
	splitter.flush()
	want := []string{`{"a":1}`, `{"b":2}`, `{"c":3}`}
	if len(lines) != len(want) {
		t.Fatalf("行数 %d，want %d：%v", len(lines), len(want), lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("第 %d 行 %q，want %q", i, lines[i], want[i])
		}
	}
}
