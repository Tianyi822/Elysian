package model

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestContentStreamsBeforeResponseCompletes(t *testing.T) {
	for _, test := range []struct{ format, first, last string }{
		{FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"content":"第一段"}}]}`), eventFrames(`{"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}`, `[DONE]`)},
		{FormatResponses, eventFrames(`{"type":"response.output_text.delta","delta":"第一段"}`), eventFrames(`{"type":"response.output_text.delta","delta":"第二段"}`, `{"type":"response.completed","response":{"object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"第一段第二段"}]}]}}`)},
		{FormatAnthropicMessages, eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"第一段"}}`), eventFrames(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第二段"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`)},
	} {
		t.Run(test.format, func(t *testing.T) {
			resume := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(resume) }) }
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, test.first)
				w.(http.Flusher).Flush()
				select {
				case <-resume:
					io.WriteString(w, test.last)
				case <-r.Context().Done():
				}
			}))
			defer server.Close()
			defer release()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			profile, input := testProfile(server.URL), testRequest()
			profile.APIFormat = test.format
			first := make(chan string, 2)
			input.OnContent = func(delta string) { first <- delta }
			done := make(chan Response, 1)
			go func() {
				response, err := NewClient(nil).Complete(ctx, profile, input)
				if err != nil {
					t.Error(err)
				}
				done <- response
			}()
			select {
			case text := <-first:
				if text != "第一段" {
					t.Fatal(text)
				}
			case <-ctx.Done():
				t.Fatal("完成前未收到回答增量")
			}
			select {
			case <-done:
				t.Fatal("模型请求提前结束")
			default:
			}
			release()
			select {
			case response := <-done:
				if response.Content != "第一段第二段" {
					t.Fatal(response.Content)
				}
			case <-ctx.Done():
				t.Fatal("流未结束")
			}
		})
	}
}
