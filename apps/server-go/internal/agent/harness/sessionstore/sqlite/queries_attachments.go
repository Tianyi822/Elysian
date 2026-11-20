package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *transaction) InsertAttachment(ctx context.Context, id string, mimeType string, bytes int, width int, height int, name string, now string, content []byte) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO agent_attachments(id,session_id,mime_type,bytes,width,height,name,created_at,content) VALUES(?,NULL,?,?,?,?,?,?,?)", id, mimeType, bytes, width, height, name, now, content)
	if err != nil {
		return 0, normalizeError("InsertAttachment", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertAttachment", err, true)
}

func (v *view) AttachmentContent(ctx context.Context, id string, mimeType *string, content *[]byte) error {
	return normalizeError("AttachmentContent", v.read(ctx, "AttachmentContent", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT mime_type,content FROM agent_attachments WHERE id=?", id).Scan(mimeType, content)
	}), v.tx != nil)
}

func (v *transaction) RemoveUnboundAttachment(ctx context.Context, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM agent_attachments WHERE id=? AND session_id IS NULL", id)
	if err != nil {
		return 0, normalizeError("RemoveUnboundAttachment", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RemoveUnboundAttachment", err, true)
}

func (v *view) AttachmentOwner(ctx context.Context, id string, document *string) error {
	return normalizeError("AttachmentOwner", v.read(ctx, "AttachmentOwner", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT session_id FROM agent_attachments WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) AttachmentMetadata(ctx context.Context, ids []string) ([]sessionstore.AttachmentMetadataRecord, error) {
	placeholders, args := attachmentPlaceholders(ids)
	values := []sessionstore.AttachmentMetadataRecord{}
	err := v.read(ctx, "AttachmentMetadata", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT id,mime_type,bytes FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.AttachmentMetadataRecord
			if err := rows.Scan(&item.ID, &item.MimeType, &item.Bytes); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("AttachmentMetadata", err, v.tx != nil)
}

func (v *view) AttachmentBytes(ctx context.Context, ids []string) ([]sessionstore.AttachmentBytesRecord, error) {
	placeholders, args := attachmentPlaceholders(ids)
	values := []sessionstore.AttachmentBytesRecord{}
	err := v.read(ctx, "AttachmentBytes", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT id,content FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.AttachmentBytesRecord
			if err := rows.Scan(&item.ID, &item.Content); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("AttachmentBytes", err, v.tx != nil)
}
