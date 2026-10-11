package files

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func transferSession(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, ok := seam.ParseSessionCookie(r.Header.Get("Cookie"))
	if !ok {
		shared.SendError(w, 401, "未登录或会话已过期")
	}
	return id, ok
}

func (m *TransferManager) mount(r chi.Router) {
	r.Post("/downloads", func(w http.ResponseWriter, r *http.Request) {
		session, ok := transferSession(w, r)
		if !ok {
			return
		}
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		path, err := requireStringField(body, "path", "路径请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		result, err := m.Prepare(r.Context(), session, path)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, result)
	})
	r.Get("/downloads/{id}", m.downloadHTTP)
	r.Post("/uploads/check", func(w http.ResponseWriter, r *http.Request) {
		session, ok := transferSession(w, r)
		if !ok {
			return
		}
		body, ok := readBody(w, r)
		if !ok {
			return
		}
		dir, err := requireStringField(body, "dirPath", "目标目录请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		name, err := requireStringField(body, "name", "文件名请求体无效")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		var size int64
		switch value := body["sizeBytes"].(type) {
		case json.Number:
			size, err = value.Int64()
		case float64:
			if value < 0 || value > float64(10<<30) || float64(int64(value)) != value {
				err = shared.InvalidRequest("上传文件大小无效")
			} else {
				size = int64(value)
			}
		default:
			err = shared.InvalidRequest("上传文件大小无效")
		}
		if err != nil || size < 0 {
			middleware.WriteError(w, shared.InvalidRequest("上传文件大小无效"))
			return
		}
		ctx, finish, err := m.begin(r.Context(), fileTransferTimeout)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		defer finish()
		result, err := m.uploads.Check(ctx, session, dir, name, size)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, result)
	})
	r.Put("/upload", m.uploadHTTP)
}

func (m *TransferManager) downloadHTTP(w http.ResponseWriter, r *http.Request) {
	session, ok := transferSession(w, r)
	if !ok {
		return
	}
	ctx, finish, err := m.begin(r.Context(), fileTransferTimeout)
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	defer finish()
	releaseSlot, err := m.acquireTransfer()
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	defer releaseSlot()
	d, err := m.claim(chi.URLParam(r, "id"), session)
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	defer m.release(d)
	if !d.archive {
		current, err := d.file.Stat()
		if err != nil || current.Size() != d.info.Size() || !current.ModTime().Equal(d.info.ModTime()) {
			middleware.WriteError(w, transferError(409, "文件在下载准备后发生变化，请重新下载"))
			return
		}
	}
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(fileTransferTimeout))
	defer controller.SetWriteDeadline(time.Time{})
	stop := context.AfterFunc(ctx, func() { _ = d.file.Close(); _ = controller.SetWriteDeadline(time.Now()) })
	defer stop()
	contentType := "application/octet-stream"
	if d.archive {
		contentType = "application/gzip"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(d.result.SizeBytes, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": d.result.Name}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if _, err := io.CopyN(w, downloadContextReader{ctx, d.file}, d.result.SizeBytes); err != nil {
		// 成功头已发送，必须中断响应而不是附加错误 JSON 或宣称完整成功。
		panic(http.ErrAbortHandler)
	}
}

func (m *TransferManager) uploadHTTP(w http.ResponseWriter, r *http.Request) {
	session, ok := transferSession(w, r)
	if !ok {
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/octet-stream" {
		middleware.WriteError(w, transferError(415, "上传文件需要 application/octet-stream 请求体"))
		return
	}
	overwrite := r.Header.Get("X-Elysian-Upload-Overwrite")
	if overwrite != "" && overwrite != "true" && overwrite != "false" {
		middleware.WriteError(w, shared.InvalidRequest("覆盖确认参数无效"))
		return
	}
	ctx, finish, err := m.begin(r.Context(), fileTransferTimeout)
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	defer finish()
	releaseSlot, err := m.acquireTransfer()
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	defer releaseSlot()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(fileTransferTimeout))
	defer controller.SetReadDeadline(time.Time{})
	stop := context.AfterFunc(ctx, func() { _ = controller.SetReadDeadline(time.Now()); _ = r.Body.Close() })
	defer stop()
	body := http.MaxBytesReader(w, r.Body, 10<<30)
	entry, err := m.uploads.Upload(ctx, session, r.URL.Query().Get("dirPath"), r.URL.Query().Get("name"), r.Header.Get("X-Elysian-Upload-Token"), overwrite == "true", body, r.ContentLength)
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, entryResponse{Entry: entry})
}
