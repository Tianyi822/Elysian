package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
)

const ImageFileLimit = 1 << 20
const ImageMessageLimit = 8 << 20

type AttachmentRef struct {
	ID string `json:"id"`
}
type MessageAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Bytes    int    `json:"bytes"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

func (c *Client) UploadImage(ctx context.Context, name string, content []byte) (MessageAttachment, error) {
	if len(content) > ImageFileLimit {
		return MessageAttachment{}, fmt.Errorf("单张图片不能超过 1 MiB")
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		return MessageAttachment{}, err
	}
	if _, err = part.Write(content); err != nil {
		return MessageAttachment{}, err
	}
	if err = w.Close(); err != nil {
		return MessageAttachment{}, err
	}
	raw, err := c.attachmentRequest(ctx, "POST", "/api/agent/attachments", w.FormDataContentType(), &body, responseLimit)
	if err != nil {
		return MessageAttachment{}, err
	}
	var result struct {
		Items []MessageAttachment `json:"items"`
	}
	if err = json.Unmarshal(raw, &result); err != nil || len(result.Items) != 1 || result.Items[0].ID == "" {
		return MessageAttachment{}, fmt.Errorf("附件上传回执无效，结果未确认")
	}
	return result.Items[0], nil
}

func (c *Client) AttachmentContent(ctx context.Context, id string) ([]byte, error) {
	// 存量附件的服务端兼容上限是 5 MiB，新上传准备至 1 MiB。
	return c.attachmentRequest(ctx, "GET", "/api/agent/attachments/"+url.PathEscape(id), "", nil, 5<<20)
}

func (c *Client) attachmentRequest(ctx context.Context, method, path, contentType string, body io.Reader, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Origin", c.baseURL)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if cookie := c.SessionCookie(); cookie != "" {
		req.AddCookie(&http.Cookie{Name: "elysian_session", Value: cookie})
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, classifyTransport(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
		return nil, serverError(resp.StatusCode, raw, 0)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("附件响应超过大小限制")
	}
	return raw, nil
}
