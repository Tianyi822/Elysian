package webfetch

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

func extract(result *Result, body []byte, contentType string) error {
	switch result.ContentType {
	case "text/html", "application/xhtml+xml":
		reader, err := charset.NewReader(bytes.NewReader(body), contentType)
		if err != nil {
			return failure("web-invalid-encoding", "网页字符编码无法解码")
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, 4*ResponseBytes+1))
		if err != nil || len(decoded) > 4*ResponseBytes {
			return failure("web-invalid-encoding", "网页字符解码失败或解码后超限")
		}
		doc, err := html.Parse(bytes.NewReader(decoded))
		if err != nil {
			return failure("web-invalid-html", "网页 HTML 无法解析")
		}
		if title := findElement(doc, "title"); title != nil {
			result.Title = nodeText(title)
		}
		root := findElement(doc, "main")
		if root == nil {
			root = findElement(doc, "article")
		}
		if root == nil {
			root = findElement(doc, "body")
		}
		if root != nil {
			var out textWriter
			base, _ := url.Parse(result.FinalURL)
			seen := map[string]bool{}
			var visit func(*html.Node, bool)
			visit = func(n *html.Node, pre bool) {
				if excluded(n) {
					return
				}
				if n.Type == html.TextNode {
					out.text(n.Data, pre)
					return
				}
				block := blockElement(n.Data)
				if block || n.Data == "br" {
					out.line()
				}
				if n.Type == html.ElementNode && n.Data == "li" {
					out.text("- ", false)
				}
				if n.Type == html.ElementNode && n.Data == "a" && len(result.Links) < MaxLinks {
					for _, attr := range n.Attr {
						if attr.Key != "href" {
							continue
						}
						ref, err := url.Parse(strings.TrimSpace(attr.Val))
						if err != nil {
							continue
						}
						link, err := normalizeURL(base.ResolveReference(ref).String())
						if err == nil && !seen[link.String()] {
							seen[link.String()] = true
							label, _ := clip(nodeText(n), 512)
							result.Links = append(result.Links, Link{URL: link.String(), Text: label})
						}
					}
				}
				for child := n.FirstChild; child != nil; child = child.NextSibling {
					visit(child, pre || n.Data == "pre")
				}
				if n.Data == "td" || n.Data == "th" {
					out.text(" ", false)
				}
				if block {
					out.line()
				}
			}
			visit(root, false)
			result.Text = strings.Trim(out.String(), "\n")
		}
	case "text/plain", "text/markdown", "application/json":
		var reader io.Reader = bytes.NewReader(body)
		var err error
		if result.ContentType != "application/json" {
			// 纯文本默认 UTF-8；只在响应明确声明编码时转换，避免将中文误判为西欧编码。
			reader, err = textReader(body, contentType)
		}
		if err != nil {
			return failure("web-invalid-encoding", "文本响应的字符编码无法解码")
		}
		decoded, err := io.ReadAll(io.LimitReader(reader, 4*ResponseBytes+1))
		if err != nil || len(decoded) > 4*ResponseBytes || !utf8.Valid(decoded) {
			return failure("web-invalid-encoding", "文本响应不是有效的文本编码")
		}
		decoded = bytes.TrimPrefix(decoded, []byte{0xef, 0xbb, 0xbf})
		if result.ContentType == "application/json" && !json.Valid(decoded) {
			return failure("web-invalid-json", "网址返回了无效的 JSON")
		}
		result.Text = strings.TrimSpace(cleanText(string(decoded)))
	default:
		return failure("web-unsupported-content", "只支持 HTML、纯文本、Markdown 和 JSON，无法读取此内容类型")
	}
	if strings.TrimSpace(result.Text) == "" {
		return failure("web-empty-content", "未读取到网页正文；页面可能需要 JavaScript 或登录")
	}
	return nil
}

func textReader(body []byte, contentType string) (io.Reader, error) {
	// 添加默认编码后仍让响应中显式的 charset 生效。
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil || params["charset"] == "" {
		return bytes.NewReader(body), nil
	}
	return charset.NewReaderLabel(params["charset"], bytes.NewReader(body))
}

func cleanText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, text)
}

func excluded(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	switch n.Data {
	case "script", "style", "noscript", "nav", "header", "footer", "aside", "template", "svg", "canvas", "iframe", "object", "embed", "form", "head":
		return true
	}
	for _, attr := range n.Attr {
		if attr.Key == "hidden" || (attr.Key == "aria-hidden" && strings.EqualFold(attr.Val, "true")) {
			return true
		}
	}
	return false
}

func findElement(n *html.Node, tag string) *html.Node {
	if n.Type == html.ElementNode && n.Data == tag {
		return n
	}
	// title 位于 head，故这里不跳过 head；其他隐藏子树不作为正文候选。
	if n.Data != "head" && excluded(n) {
		return nil
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		if found := findElement(child, tag); found != nil {
			return found
		}
	}
	return nil
}

func nodeText(n *html.Node) string {
	var out textWriter
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if excluded(node) {
			return
		}
		if node.Type == html.TextNode {
			out.text(node.Data, false)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(n)
	return strings.TrimSpace(out.String())
}

func blockElement(tag string) bool {
	switch tag {
	case "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "ul", "ol", "li", "table", "tr", "dl", "dt", "dd", "hr":
		return true
	}
	return false
}

type textWriter struct {
	strings.Builder
	pending bool
	last    rune
}

func (w *textWriter) text(text string, pre bool) {
	for _, r := range cleanText(text) {
		if !pre && unicode.IsSpace(r) {
			w.pending = true
			continue
		}
		if w.pending && w.Len() > 0 && w.last != '\n' {
			w.WriteByte(' ')
		}
		w.pending = false
		w.WriteRune(r)
		w.last = r
	}
}

func (w *textWriter) line() {
	w.pending = false
	if w.Len() > 0 && w.last != '\n' {
		w.WriteByte('\n')
		w.last = '\n'
	}
}
