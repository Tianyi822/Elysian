package harness

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

// 附件只接受 JPEG 与 PNG：按文件头魔数判定，忽略声明 MIME 与扩展名，
// 取智谱与 DeepSeek 两家交集；单边像素上限同样取两家约束的交集。
const (
	attachmentMIMEJPEG = "image/jpeg"
	attachmentMIMEPNG  = "image/png"
	maxImageEdge       = 6000
	// orphanAttachmentAge 是未绑定附件的保留期：上传后从未随消息发送的字节按此清理。
	orphanAttachmentAge = 24 * time.Hour
	// 单文件配置上限保留旧策略的兼容范围；新消息图片总预算独立于单文件策略。
	maxImageAttachmentFileBytes = 5 * 1024 * 1024
	maxImageAttachmentSetBytes  = 8 * 1024 * 1024
)

// sniffImageMIME 按魔数判定图片格式；无法识别返回空串。
func sniffImageMIME(data []byte) string {
	if len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
		return attachmentMIMEJPEG
	}
	if len(data) >= 8 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4E && data[3] == 0x47 &&
		data[4] == 0x0D && data[5] == 0x0A && data[6] == 0x1A && data[7] == 0x0A {
		return attachmentMIMEPNG
	}
	return ""
}

// probeAttachment 校验单张图片字节并读取尺寸；返回魔数判定的 MIME 与宽高。
func probeAttachment(data []byte) (string, int, int, error) {
	mimeType := sniffImageMIME(data)
	if mimeType == "" {
		return "", 0, 0, bad("invalid-attachment-format", "附件必须是 JPEG 或 PNG 图片")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", 0, 0, bad("invalid-attachment-format", "附件必须是 JPEG 或 PNG 图片")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > maxImageEdge || config.Height > maxImageEdge {
		return "", 0, 0, bad("invalid-attachment-size", "图片单边尺寸不能超过 6000 像素")
	}
	return mimeType, config.Width, config.Height, nil
}

// dedupeAttachmentRefs 保序去重：重复 id 与去重后输入视为同一引用，不重复计数。
func dedupeAttachmentRefs(refs []AttachmentRef) []AttachmentRef {
	if len(refs) < 2 {
		return refs
	}
	seen := make(map[string]bool, len(refs))
	out := refs[:0:0]
	for _, ref := range refs {
		if seen[ref.ID] {
			continue
		}
		seen[ref.ID] = true
		out = append(out, ref)
	}
	return out
}

// AttachmentUpload 是上传端点解析出的单个文件；Name 取 part 文件名。
type AttachmentUpload struct {
	Name    string
	Content []byte
}

func (m *Manager) CreateAttachments(ctx context.Context, uploads []AttachmentUpload) ([]MessageAttachment, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	if len(uploads) == 0 {
		return nil, bad("invalid-upload", "附件上传缺少文件")
	}
	limits := m.deps.AgentLimits
	// 张数/单文件/总字节与提交侧同走 validateAttachmentSet（按运行时 AgentLimits，
	// 0 表示不限制）：判定与文案单点维护，不再内联第二套口径。
	precheck := make([]attachmentRow, 0, len(uploads))
	for _, upload := range uploads {
		precheck = append(precheck, attachmentRow{MessageAttachment: MessageAttachment{Bytes: len(upload.Content)}})
	}
	if err := hstate.ValidateAttachmentSet(precheck, limits); err != nil {
		return nil, err
	}
	rows := make([]attachmentRow, 0, len(uploads))
	for _, upload := range uploads {
		mimeType, width, height, err := probeAttachment(upload.Content)
		if err != nil {
			return nil, err
		}
		name := strings.TrimSpace(upload.Name)
		if name == "" {
			name = "图片"
		}
		if len(name) > 200 {
			name = name[:200]
		}
		rows = append(rows, attachmentRow{MessageAttachment: MessageAttachment{ID: m.deps.NewID(), Name: name, MimeType: mimeType, Bytes: len(upload.Content), Width: width, Height: height}})
	}
	err := writeStore(m.store, ctx, "create-attachments", func(tx sessionstore.Tx) error {
		for i := range rows {
			if _, err := tx.InsertAttachment(ctx, rows[i].ID, rows[i].MimeType, rows[i].Bytes, rows[i].Width, rows[i].Height, rows[i].Name, stamp(m.deps.Now()), uploads[i].Content); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, storageFailure(err)
	}
	out := make([]MessageAttachment, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.MessageAttachment)
	}
	return out, nil
}

func (m *Manager) AttachmentContent(ctx context.Context, id string) (string, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return "", nil, closedError()
	}
	type attachment struct {
		mimeType string
		content  []byte
	}
	value, err := storeRead(ctx, m.store, "AttachmentContent", func(ctx context.Context) (attachment, error) {
		var value attachment
		err := readView(ctx, m.store).AttachmentContent(ctx, id, &value.mimeType, &value.content)
		if errors.Is(err, sessionstore.ErrNotFound) {
			return value, bad("attachment-not-found", "附件不存在")
		}
		return value, err
	})
	return value.mimeType, value.content, storageFailure(err)
}

// DeleteAttachment 仅允许删除未绑定会话的附件；已随消息发送的字节属于会话历史。
func (m *Manager) DeleteAttachment(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return closedError()
	}
	var deleted int
	err := writeStore(m.store, ctx, "delete-attachment", func(tx sessionstore.Tx) error {
		result, err := tx.RemoveUnboundAttachment(ctx, id)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		deleted = int(affected)
		return nil
	})
	if err != nil {
		return storageFailure(err)
	}
	if deleted == 0 {
		var bound string
		if err = readView(ctx, m.store).AttachmentOwner(ctx, id, &bound); errors.Is(err, sessionstore.ErrNotFound) {
			return bad("attachment-not-found", "附件不存在")
		} else if err != nil {
			return storageFailure(err)
		}
		return bad("attachment-in-use", "附件已随消息发送，不能单独删除")
	}
	return nil
}
