package harness

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	"strings"
	"time"

	_ "image/jpeg"
	_ "image/png"
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

// imageLimitLabel 把字节限额渲染成中文可读文案：整 MiB 用 MiB，否则按字节。
func imageLimitLabel(bytes int) string {
	if bytes > 0 && bytes%1048576 == 0 {
		return fmt.Sprintf("%d MiB", bytes/1048576)
	}
	return fmt.Sprintf("%d 字节", bytes)
}

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

type attachmentRow struct {
	MessageAttachment
	SessionID string
}

func attachmentPlaceholders(ids []string) (string, []any) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	return placeholders, args
}

// readAttachmentRows 按引用顺序读取附件行；任一 id 不存在即返回 attachment-invalid。
func readAttachmentRows(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, refs []AttachmentRef, sessionID string) ([]attachmentRow, error) {
	placeholders, args := attachmentPlaceholders(func() []string {
		ids := make([]string, 0, len(refs))
		for _, ref := range refs {
			ids = append(ids, ref.ID)
		}
		return ids
	}())
	rows, err := q.QueryContext(ctx, "SELECT id,session_id,mime_type,bytes,width,height,name FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]attachmentRow, len(refs))
	for rows.Next() {
		var row attachmentRow
		var sessionID sql.NullString
		if err = rows.Scan(&row.ID, &sessionID, &row.MimeType, &row.Bytes, &row.Width, &row.Height, &row.Name); err != nil {
			return nil, err
		}
		row.SessionID = sessionID.String
		byID[row.ID] = row
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := make([]attachmentRow, 0, len(refs))
	for _, ref := range refs {
		row, ok := byID[ref.ID]
		if !ok || row.SessionID != "" && row.SessionID != sessionID {
			return nil, bad("attachment-invalid", "附件不存在或已被使用，请重新添加")
		}
		out = append(out, row)
	}
	return out, nil
}

// validateAttachmentSet 按 Limits 复检附件集合：张数、单文件字节与总字节。
// 附件行上传后不可变，提交侧复检无竞态，堵住分批上传攒出超限集合再一次提交的绕过；
// 张数为 0 表示不限制数量；旧快照总量为 0 表示不设置独立总量限制。
func validateAttachmentSet(rows []attachmentRow, limits Limits) error {
	if len(rows) == 0 {
		return nil
	}
	if limits.ImageCountPerMessage > 0 && len(rows) > limits.ImageCountPerMessage {
		return bad("attachment-too-many", "一条消息最多 "+fmt.Sprint(limits.ImageCountPerMessage)+" 张图片")
	}
	total := 0
	for _, row := range rows {
		if limits.ImageBytesPerFile > 0 && row.Bytes > limits.ImageBytesPerFile {
			return bad("attachment-too-large", "单张图片不能超过 "+imageLimitLabel(limits.ImageBytesPerFile)+"。")
		}
		total += row.Bytes
	}
	if limits.ImageBytesPerMessage > 0 && total > limits.ImageBytesPerMessage {
		if limits.ImageBytesPerMessage == maxImageAttachmentSetBytes {
			return bad("attachment-message-too-large", "本条消息附件合计超过 8 MiB，请分批发送。")
		}
		return bad("attachment-message-too-large", "图片总大小不能超过 "+imageLimitLabel(limits.ImageBytesPerMessage)+"，请分批发送。")
	}
	return nil
}

// bindAttachments 在事务内把附件行绑定到会话；放行「已绑定本会话」的行以支撑
// 编辑重发复用原轮 id。核对以调用方事务内 SELECT 结果为准，UPDATE 仅执行置位，
// 不依赖驱动 RowsAffected 对「值未变化行」的计数口径。
func bindAttachments(ctx context.Context, tx *sql.Tx, sessionID string, refs []AttachmentRef) error {
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.ID)
	}
	placeholders, idArgs := attachmentPlaceholders(ids)
	// 参数顺序与 SQL 占位符一致：SET 的会话 id、IN 的引用 id、谓词末尾的会话 id。
	args := append([]any{sessionID}, idArgs...)
	args = append(args, sessionID)
	_, err := tx.ExecContext(ctx, "UPDATE agent_attachments SET session_id=? WHERE id IN ("+placeholders+") AND (session_id IS NULL OR session_id=?)", args...)
	return err
}

// sweepOrphanAttachments 清理上传后从未绑定会话且超过保留期的附件字节。
func (s *store) sweepOrphanAttachments(ctx context.Context, tx *sql.Tx) error {
	cutoff := stamp(s.now().Add(-orphanAttachmentAge))
	_, err := tx.ExecContext(ctx, "DELETE FROM agent_attachments WHERE session_id IS NULL AND julianday(created_at)<julianday(?)", cutoff)
	return err
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
	if err := validateAttachmentSet(precheck, limits); err != nil {
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
	err := m.store.write(ctx, "create-attachments", func(tx *sql.Tx) error {
		for i := range rows {
			if _, err := tx.ExecContext(ctx, "INSERT INTO agent_attachments(id,session_id,mime_type,bytes,width,height,name,created_at,content) VALUES(?,NULL,?,?,?,?,?,?,?)",
				rows[i].ID, rows[i].MimeType, rows[i].Bytes, rows[i].Width, rows[i].Height, rows[i].Name, stamp(m.deps.Now()), uploads[i].Content); err != nil {
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
	var mimeType string
	var content []byte
	err := m.store.db.QueryRowContext(ctx, "SELECT mime_type,content FROM agent_attachments WHERE id=?", id).Scan(&mimeType, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, bad("attachment-not-found", "附件不存在")
	}
	if err != nil {
		return "", nil, storageFailure(err)
	}
	return mimeType, content, nil
}

// DeleteAttachment 仅允许删除未绑定会话的附件；已随消息发送的字节属于会话历史。
func (m *Manager) DeleteAttachment(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return closedError()
	}
	var deleted int
	err := m.store.write(ctx, "delete-attachment", func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, "DELETE FROM agent_attachments WHERE id=? AND session_id IS NULL", id)
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
		if err = m.store.db.QueryRowContext(ctx, "SELECT session_id FROM agent_attachments WHERE id=?", id).Scan(&bound); errors.Is(err, sql.ErrNoRows) {
			return bad("attachment-not-found", "附件不存在")
		} else if err != nil {
			return storageFailure(err)
		}
		return bad("attachment-in-use", "附件已随消息发送，不能单独删除")
	}
	return nil
}
