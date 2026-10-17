package model

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var upstreamRequestID = regexp.MustCompile(`\(request_id: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)`)

// 只将固定错误模式翻译为本地提示，原始正文不保存、不回显。
func responseError(response *http.Response) error {
	err := responseStatusError(response.StatusCode)
	if err == nil || (response.StatusCode != 400 && response.StatusCode != 422) {
		return err
	}
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8192))
	if readErr != nil {
		return err
	}
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return err
	}
	message := body.Error.Message
	for _, field := range []string{"content[].thinking", "reasoning_content"} {
		prefix := "The `" + field + "` in the thinking mode must be passed back to the API."
		if message != prefix && !strings.HasPrefix(message, prefix+" (request_id: ") {
			continue
		}
		diagnostic := "模型服务返回异常状态（HTTP " + httpStatusText(response.StatusCode) + "）：思考模式的工具续接缺少思考字段，请检查模型协议适配"
		if match := upstreamRequestID.FindStringSubmatch(strings.TrimPrefix(message, prefix)); len(match) == 2 && strings.TrimSpace(strings.TrimPrefix(message, prefix)) == match[0] {
			diagnostic += "（请求编号：" + match[1] + "）"
		}
		return problem(502, "model-thinking-continuation-required", diagnostic)
	}
	return err
}

func httpStatusText(status int) string {
	if status == 422 {
		return "422"
	}
	return "400"
}
