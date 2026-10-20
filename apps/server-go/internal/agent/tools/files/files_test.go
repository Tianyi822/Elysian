package files

import (
	"context"
	"errors"
	"testing"

	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/files"
	"elysian/server/internal/seam"
)

type testAccounts struct{}

func (testAccounts) PasswdAll(context.Context) ([]seam.PasswdRecord, error) { return nil, nil }
func (testAccounts) PasswdByName(context.Context, string) (*seam.PasswdRecord, error) {
	return nil, nil
}

func TestDynamicFileToolsDiscoverableWithoutGrantAndCannotAuthorizeThemselves(t *testing.T) {
	called := false
	facade, err := domain.NewAgentFacade(domain.Deps{Available: true, Accounts: testAccounts{}}, domain.AgentOptions{
		Authorize: func(context.Context) error { return errors.New("missing dispatch") },
		ResolveRoot: func(context.Context, string, bool) (domain.AgentRootAuthorization, error) {
			called = true
			return domain.AgentRootAuthorization{}, errors.New("missing root authorization")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := tools.NewRuntime(context.Background(), Plugin(Deps{Facade: facade}, Config{}))
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(context.Background())
	schemas := runtime.Schemas()
	if len(schemas) != 6 {
		t.Fatalf("discovered %d file tools, want 6", len(schemas))
	}
	for _, schema := range schemas {
		properties := schema.Parameters["properties"].(map[string]any)
		root := properties["root"].(map[string]any)
		if root["type"] != tools.SchemaString {
			t.Fatalf("root is not a string: %+v", root)
		}
		if _, exists := root["enum"]; exists {
			t.Fatalf("dynamic root is restricted to startup grants: %+v", root)
		}
	}
	if _, err := runtime.Execute(context.Background(), "file_read", map[string]any{"root": "/var/www/business", "path": "record.txt"}); err == nil {
		t.Fatal("model arguments authorized a file read")
	}
	if called {
		t.Fatal("resolver used without dispatch authority")
	}
}
