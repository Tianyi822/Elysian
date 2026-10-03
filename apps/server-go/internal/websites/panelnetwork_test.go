package websites

import (
	"context"
	"elysian/server/internal/contract"
	"strings"
	"testing"
)

func TestWebsiteUsesActualPanelReservedPorts(t *testing.T) {
	s := &websiteService{deps: serviceDeps{reservedPorts: []int{22, 49000, 49001}, listPortBindings: func(context.Context) ([]contract.PortBindingView, error) { return nil, nil }}}
	for _, port := range []int{49000, 49001} {
		if err := s.assertPortAvailable(context.Background(), port, nil); err == nil || !strings.Contains(err.Error(), "面板保留") {
			t.Fatalf("端口 %d 未保护：%v", port, err)
		}
	}
	if err := s.assertPortAvailable(context.Background(), 48100, nil); err != nil {
		t.Fatalf("旧默认端口未释放：%v", err)
	}
}
