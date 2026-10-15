package harness

import (
	"bytes"
	"context"
	"database/sql"
	"image"
	"image/jpeg"
	"image/png"
	mp "mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func testPNGBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func testJPEGBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewGray(image.Rect(0, 0, width, height)), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// paddedImage 在合法图片头之后追加填充字节：DecodeConfig 只读头部，用于构造
// 指定字节数的附件而不必真的编码大图。
func paddedImage(t *testing.T, base []byte, size int) []byte {
	t.Helper()
	if size < len(base) {
		t.Fatal("填充目标小于图片头")
	}
	return append(append([]byte{}, base...), make([]byte, size-len(base))...)
}

func attachmentsTestManager(t *testing.T) *Manager {
	t.Helper()
	s, _ := openRuntimeTestStore(t)
	return &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }, NewID: randomID, AgentLimits: DefaultAgentLimits()}, wake: make(chan struct{}, 1)}
}

func TestAttachmentProbeFormatAndEdge(t *testing.T) {
	if mimeType, width, height, err := probeAttachment(testPNGBytes(t, 2, 3)); err != nil || mimeType != "image/png" || width != 2 || height != 3 {
		t.Fatalf("PNG 探测错误：%s %d %d %v", mimeType, width, height, err)
	}
	if mimeType, width, height, err := probeAttachment(testJPEGBytes(t, 4, 5)); err != nil || mimeType != "image/jpeg" || width != 4 || height != 5 {
		t.Fatalf("JPEG 探测错误：%s %d %d %v", mimeType, width, height, err)
	}
	for name, data := range map[string][]byte{
		"gif":     append([]byte("GIF89a"), make([]byte, 64)...),
		"webp":    append([]byte{0x52, 0x49, 0x46, 0x46}, make([]byte, 64)...),
		"pdf":     []byte("%PDF-1.7 ..."),
		"空字节":     {},
		"jpeg 截断": {0xFF, 0xD8},
		"png 尾错位": {0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0B},
	} {
		if _, _, _, err := probeAttachment(data); err == nil || err.(*Error).Code != "invalid-attachment-format" {
			t.Fatalf("%s 应按格式拒绝：%v", name, err)
		}
	}
	for name, data := range map[string][]byte{
		"超宽 PNG":  testPNGBytes(t, 6001, 1),
		"超高 JPEG": testJPEGBytes(t, 1, 6001),
	} {
		if _, _, _, err := probeAttachment(data); err == nil || err.(*Error).Code != "invalid-attachment-size" {
			t.Fatalf("%s 应按尺寸拒绝：%v", name, err)
		}
	}
}

func TestAttachmentCreateLimits(t *testing.T) {
	m := attachmentsTestManager(t)
	ctx := context.Background()
	png := testPNGBytes(t, 1, 1)
	jpeg := testJPEGBytes(t, 1, 1)
	items, err := m.CreateAttachments(ctx, []AttachmentUpload{{Name: "a.png", Content: png}, {Name: "b.jpg", Content: jpeg}})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].MimeType != "image/png" || items[1].MimeType != "image/jpeg" || items[0].Bytes != len(png) || items[0].Width != 1 {
		t.Fatalf("上传回执错误：%+v", items)
	}
	uploads := make([]AttachmentUpload, 51)
	for i := range uploads {
		uploads[i] = AttachmentUpload{Name: "small.png", Content: png}
	}
	if items, err = m.CreateAttachments(ctx, uploads); err != nil || len(items) != len(uploads) {
		t.Fatalf("总字节合规的 51 张图片应可上传：%d %v", len(items), err)
	}
	if _, err = m.CreateAttachments(ctx, []AttachmentUpload{{Name: "big.png", Content: paddedImage(t, png, 1048577)}}); err == nil || err.(*Error).Code != "attachment-too-large" {
		t.Fatalf("单文件字节未拦截：%v", err)
	}
	full := paddedImage(t, png, 1048576)
	uploads = make([]AttachmentUpload, 8)
	for i := range uploads {
		uploads[i] = AttachmentUpload{Name: "full.png", Content: full}
	}
	if items, err = m.CreateAttachments(ctx, uploads); err != nil || len(items) != 8 {
		t.Fatalf("合计等于 8 MiB 的图片应可上传：%d %v", len(items), err)
	}
	uploads[7].Content = paddedImage(t, png, 1048576-len(png)+1)
	uploads = append(uploads, AttachmentUpload{Name: "extra.png", Content: png})
	if _, err = m.CreateAttachments(ctx, uploads); err == nil || err.(*Error).Code != "attachment-message-too-large" || err.Error() != "本条消息附件合计超过 8 MiB，请分批发送。" {
		t.Fatalf("合计超过 8 MiB 一个字节应提示分批发送：%v", err)
	}
	// 旧正数总量策略仍可复检历史快照，不改变已保存限额的语义。
	m.deps.AgentLimits.ImageCountPerMessage = 4
	m.deps.AgentLimits.ImageBytesPerFile = 4194304
	m.deps.AgentLimits.ImageBytesPerMessage = 4194304
	if _, err = m.CreateAttachments(ctx, []AttachmentUpload{
		{Name: "half1.png", Content: paddedImage(t, png, 2202009)},
		{Name: "half2.png", Content: paddedImage(t, png, 2202009)},
	}); err == nil || err.(*Error).Code != "attachment-message-too-large" {
		t.Fatalf("总字节未拦截：%v", err)
	}
	if _, err = m.CreateAttachments(ctx, []AttachmentUpload{
		{Name: "a.png", Content: png}, {Name: "b.png", Content: png}, {Name: "c.png", Content: png},
		{Name: "d.png", Content: png}, {Name: "e.png", Content: png},
	}); err == nil || err.(*Error).Code != "attachment-too-many" {
		t.Fatalf("旧正数张数策略未保留：%v", err)
	}
}

func TestAttachmentDeleteAndOrphanSweep(t *testing.T) {
	m := attachmentsTestManager(t)
	ctx := context.Background()
	png := testPNGBytes(t, 1, 1)
	items, err := m.CreateAttachments(ctx, []AttachmentUpload{{Name: "keep.png", Content: png}, {Name: "remove.png", Content: png}, {Name: "stale.png", Content: png}})
	if err != nil {
		t.Fatal(err)
	}
	if err = m.DeleteAttachment(ctx, items[1].ID); err != nil {
		t.Fatal(err)
	}
	if err = m.DeleteAttachment(ctx, items[1].ID); err == nil || err.(*Error).Code != "attachment-not-found" {
		t.Fatalf("重复删除未拒绝：%v", err)
	}
	if _, _, err = m.AttachmentContent(ctx, items[1].ID); err == nil || err.(*Error).Code != "attachment-not-found" {
		t.Fatalf("删除后仍可读取：%v", err)
	}
	mimeType, content, err := m.AttachmentContent(ctx, items[0].ID)
	if err != nil || mimeType != "image/png" || !bytes.Equal(content, png) {
		t.Fatalf("回读字节错误：%s %v", mimeType, err)
	}
	// 已绑定会话的附件不能单独删除，字节属于会话历史（外键要求会话真实存在）。
	s := m.store
	if err := s.createSession(ctx, Session{ID: "session-x", Title: "占用", CreatedAt: stamp(runtimeStoreTestTime), LastActivityAt: stamp(runtimeStoreTestTime), LastSeq: "0"}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.store.db.ExecContext(ctx, "UPDATE agent_attachments SET session_id='session-x' WHERE id=?", items[2].ID); err != nil {
		t.Fatal(err)
	}
	if err = m.DeleteAttachment(ctx, items[2].ID); err == nil || err.(*Error).Code != "attachment-in-use" {
		t.Fatalf("已绑定附件被单独删除：%v", err)
	}
	// 孤儿清理：未绑定且超过 24 小时的字节被清走，绑定行与新上传保留。
	if _, err = m.store.db.ExecContext(ctx, "UPDATE agent_attachments SET created_at=? WHERE id=?", stamp(runtimeStoreTestTime.Add(-25*time.Hour)), items[0].ID); err != nil {
		t.Fatal(err)
	}
	if err = m.store.sweep(ctx, 30); err != nil {
		t.Fatal(err)
	}
	var orphan, bound int
	if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_attachments WHERE id=?", items[0].ID).Scan(&orphan); err != nil {
		t.Fatal(err)
	}
	if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_attachments WHERE id=?", items[2].ID).Scan(&bound); err != nil {
		t.Fatal(err)
	}
	if orphan != 0 || bound != 1 {
		t.Fatalf("孤儿清理错误：orphan=%d bound=%d", orphan, bound)
	}
}

func TestAttachmentDedupeAndBindingRules(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	png := testPNGBytes(t, 1, 1)
	if _, err := s.db.ExecContext(ctx, "INSERT INTO agent_attachments(id,session_id,mime_type,bytes,width,height,name,created_at,content) VALUES(?,NULL,'image/png',?,1,1,'a.png',?,?)",
		"attach-a", len(png), stamp(runtimeStoreTestTime), png); err != nil {
		t.Fatal(err)
	}
	other := Session{ID: "session-other", Title: "他方", CreatedAt: stamp(runtimeStoreTestTime), LastActivityAt: stamp(runtimeStoreTestTime), LastSeq: "0"}
	if err := s.createSession(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, "INSERT INTO agent_attachments(id,session_id,mime_type,bytes,width,height,name,created_at,content) VALUES(?,?, 'image/png',?,1,1,'o.png',?,?)",
		"attach-other", other.ID, len(png), stamp(runtimeStoreTestTime), png); err != nil {
		t.Fatal(err)
	}
	if refs := dedupeAttachmentRefs([]AttachmentRef{{ID: "a"}, {ID: "b"}, {ID: "a"}}); len(refs) != 2 || refs[0].ID != "a" || refs[1].ID != "b" {
		t.Fatalf("去重失去保序：%+v", refs)
	}
	session, task, run := sessionStoreFixture(t, s, "attach-bind", runtimeStoreTestTime)
	run.Selection = &AgentInput{RequestID: run.RequestID, Content: run.Input, Attachments: []AttachmentRef{{ID: "attach-a"}, {ID: "attach-missing"}}}
	if _, _, err := s.acceptAgent(ctx, task, run, "attach-bind-input", "message-bind", true); err == nil || err.(*Error).Code != "attachment-invalid" {
		t.Fatalf("缺失引用未整体回滚：%v", err)
	}
	var bound int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_attachments WHERE id='attach-a' AND session_id<>''").Scan(&bound); err != nil || bound != 0 {
		t.Fatalf("回滚后附件被绑定：%d %v", bound, err)
	}
	run.Selection.Attachments = []AttachmentRef{{ID: "attach-a"}, {ID: "attach-other"}}
	if _, _, err := s.acceptAgent(ctx, task, run, "attach-bind-input", "message-bind", true); err == nil || err.(*Error).Code != "attachment-invalid" {
		t.Fatalf("他人会话附件未拒绝：%v", err)
	}
	run.Selection.Attachments = []AttachmentRef{{ID: "attach-a"}}
	accepted, _, err := s.acceptAgent(ctx, task, run, "attach-bind-input", "message-bind", true)
	if err != nil {
		t.Fatal(err)
	}
	finishSessionTestRun(t, s, accepted.ID, "原回复", &WorkingMemory{Revision: 1, Coverage: MemoryCursor{RunNumber: 1, EventSeq: "1"}, Summary: "原记忆"})
	if err = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_attachments WHERE id='attach-a' AND session_id=?", session.ID).Scan(&bound); err != nil || bound != 1 {
		t.Fatalf("附件未绑定会话：%d %v", bound, err)
	}
	page, err := s.messages(ctx, session.ID, "0", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].Role != "user" || len(page.Items[0].Attachments) != 1 || page.Items[0].Attachments[0].ID != "attach-a" || page.Items[0].Attachments[0].Name != "a.png" {
		t.Fatalf("消息未携带附件描述符：%+v", page.Items)
	}
	// 编辑重发复用已绑定本会话的 id：绑定谓词放行「已绑定本会话」的行。
	next := accepted
	next.ID, next.RequestID, next.Input = "run-attach-edit", "request-attach-edit", "改写输入"
	next.Selection = &AgentInput{RequestID: next.RequestID, Content: next.Input, ReplaceMessageID: "message-bind", Attachments: []AttachmentRef{{ID: "attach-a"}}}
	if _, _, err = s.acceptAgent(ctx, task, next, "attach-edit-input", "message-edit", false); err != nil {
		t.Fatalf("编辑重发复用已绑定附件失败：%v", err)
	}
	// JSONL 副本不镜像附件字节：表未登记进 recordSpecs。
	var outbox int
	if err = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_record_outbox WHERE fact_type='agent_attachments'").Scan(&outbox); err != nil && err != sql.ErrNoRows {
		t.Fatal(err)
	}
	if outbox != 0 {
		t.Fatalf("附件字节进入 JSONL 副本：%d", outbox)
	}
}

// TestAttachmentUploadRoute 覆盖 multipart handler 校验：仅接受名为 file 的 part，
// 魔数格式与单请求限额在入库前拒绝，回执带描述符数组。
func TestAttachmentUploadRoute(t *testing.T) {
	client := &imagesTestClient{}
	m, _, _ := agentManager(t, client.complete, nil)
	router := m.Router()
	png := testPNGBytes(t, 2, 2)
	buildMultipart := func(parts ...[2]string) (*http.Request, string) {
		var buf bytes.Buffer
		writer := mp.NewWriter(&buf)
		boundary := writer.Boundary()
		for _, part := range parts {
			if part[0] == "file" {
				file, _ := writer.CreateFormFile("file", part[1])
				_, _ = file.Write(png)
			} else {
				_ = writer.WriteField(part[0], part[1])
			}
		}
		_ = writer.Close()
		return httptest.NewRequest(http.MethodPost, "http://localhost/api/agent/attachments", bytes.NewReader(buf.Bytes())), boundary
	}
	send := func(req *http.Request, boundary string) *httptest.ResponseRecorder {
		req.Header.Set("Origin", "http://localhost")
		req.Header.Set("Content-Type", "multipart/form-data; boundary="+boundary)
		recorder := httptest.NewRecorder()
		mount := chi.NewRouter()
		mount.Mount("/api/agent", router)
		mount.ServeHTTP(recorder, req)
		return recorder
	}
	req, boundary := buildMultipart([2]string{"file", "图.png"}, [2]string{"file", "b.png"})
	response := send(req, boundary)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"mimeType":"image/png"`) {
		t.Fatalf("multipart 上传回执错误：%d %s", response.Code, response.Body.String())
	}
	req, boundary = buildMultipart([2]string{"metadata", "x"})
	if response = send(req, boundary); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "invalid-upload") {
		t.Fatalf("part 名错误未被拒绝：%d %s", response.Code, response.Body.String())
	}
	parts := make([][2]string, 51)
	for i := range parts {
		parts[i] = [2]string{"file", "small.png"}
	}
	req, boundary = buildMultipart(parts...)
	if response = send(req, boundary); response.Code != http.StatusCreated || strings.Count(response.Body.String(), `"mimeType":"image/png"`) != len(parts) {
		t.Fatalf("总字节合规的 51 张图片上传回执错误：%d %s", response.Code, response.Body.String())
	}
	req = httptest.NewRequest(http.MethodPost, "http://localhost/api/agent/attachments", strings.NewReader("not multipart"))
	req.Header.Set("Origin", "http://localhost")
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	mount := chi.NewRouter()
	mount.Mount("/api/agent", router)
	mount.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid-content-type") {
		t.Fatalf("非 multipart 请求未被拒绝：%d %s", recorder.Code, recorder.Body.String())
	}
}

func TestAgentImageLimitCeiling(t *testing.T) {
	agent := DefaultAgentLimits()
	if agent.ImageCountPerMessage != 0 || agent.ImageBytesPerFile != 1048576 || agent.ImageBytesPerMessage != 8388608 {
		t.Fatalf("默认图片策略错误：%+v", agent)
	}
	if err := validateAgentLimits(agent); err != nil {
		t.Fatalf("总字节有界时应允许不设置张数限制：%v", err)
	}
	agent.ImageBytesPerFile = maxImageAttachmentFileBytes + 1
	if err := validateAgentLimits(agent); err == nil {
		t.Fatal("Agent 单文件字节越过 5 MiB 上限未被拒绝")
	}
	agent = DefaultAgentLimits()
	agent.ImageCountPerMessage = 51
	if err := validateAgentLimits(agent); err != nil {
		t.Fatalf("总字节有界时不应按张数乘单张上限拒绝：%v", err)
	}
	agent = DefaultAgentLimits()
	agent.ImageCountPerMessage = 4
	agent.ImageBytesPerFile = 4194304
	agent.ImageBytesPerMessage = 4194304
	if err := validateAgentLimits(agent); err != nil {
		t.Fatalf("旧正数图片总量策略应保持兼容：%v", err)
	}
	for _, field := range []string{"count-negative", "file", "total", "total-too-large"} {
		agent = DefaultAgentLimits()
		switch field {
		case "count-negative":
			agent.ImageCountPerMessage = -1
		case "file":
			agent.ImageBytesPerFile = 0
		case "total":
			agent.ImageBytesPerMessage = 0
		case "total-too-large":
			agent.ImageBytesPerMessage = maxImageAttachmentSetBytes + 1
		}
		if err := validateAgentLimits(agent); err == nil {
			t.Fatalf("Agent 通道无效的 %s 限额未被拒绝", field)
		}
	}
	batch := DefaultLimits()
	batch.ImageBytesPerFile = maxImageAttachmentFileBytes + 1
	if err := validateLimits(batch); err == nil {
		t.Fatal("批处理通道字节上限未同步收紧")
	}
	batch.ImageBytesPerFile = 0
	if err := validateLimits(batch); err != nil {
		t.Fatal("批处理通道不允许以 0 表示不开放图片")
	}
}
