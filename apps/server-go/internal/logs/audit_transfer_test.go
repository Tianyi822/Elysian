package logs

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type deadlineWriter struct {
	*httptest.ResponseRecorder
	readDeadline time.Time
}

func (w *deadlineWriter) SetReadDeadline(value time.Time) error { w.readDeadline = value; return nil }

func TestAuditWriterPreservesUploadReadDeadline(t *testing.T) {
	w := &deadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	controller := http.NewResponseController(&statusRecorder{ResponseWriter: w})
	deadline := time.Now().Add(time.Minute)
	if err := controller.SetReadDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	if !w.readDeadline.Equal(deadline) {
		t.Fatal("上传读取时限未透传")
	}
}

func TestFileUploadAuditDoesNotBufferContent(t *testing.T) {
	desc := operationDescriptors["PUT /api/files/upload"]
	if desc == nil || desc.category != "files" || desc.summarize != nil {
		t.Fatal("文件上传必须记录动作且禁止读取正文")
	}
}
