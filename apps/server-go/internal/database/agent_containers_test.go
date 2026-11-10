package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"elysian/server/internal/seam"
)

type failedMutationRegistry struct{ databaseRegistry }

func (r failedMutationRegistry) put(databaseRecord) error {
	return errors.New("PRIVATE_REGISTRY_FAILURE")
}
func (r failedMutationRegistry) remove(string) error { return errors.New("PRIVATE_REGISTRY_FAILURE") }

func TestContainerChangePreservesUnknownAfterSQLWhenRegistryFails(t *testing.T) {
	fixture := newServiceFixture("8.4")
	bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
	create, _, err := bridge.PrepareCreate(context.Background(), seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}, testImageID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := create(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	fixture.service.deps.registry = failedMutationRegistry{fixture.registry}
	remove, err := bridge.PrepareChange(context.Background(), rows[0].ContainerID, "request", seam.AgentDatabaseChange{Action: "remove", Name: "orders", ExpectedRevision: containerRevision(rows)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = remove(context.Background())
	var receipt *seam.AgentContainerError
	if !errors.As(err, &receipt) || receipt.NoBusinessEffect || receipt.NotDispatched || strings.Contains(receipt.Message, "PRIVATE") {
		t.Fatalf("unsafe registry failure receipt: %+v %v", receipt, err)
	}
	if !slices.Contains(fixture.protocol.trace.items, "drop") {
		t.Fatal("did not reach SQL effect")
	}
	after, _ := fixture.registry.list()
	if containerRevision(rows) != containerRevision(after) {
		t.Fatal("failed registry write changed the fixture")
	}
}

func TestContainerCreateOnStoppedManagedDatabaseIsConfirmedNoEffect(t *testing.T) {
	fixture := newServiceFixture("8.4")
	bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
	create, _, err := bridge.PrepareCreate(context.Background(), seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}, testImageID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := create(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	fixture.docker.inspectInfos[rows[0].ContainerID]["State"] = map[string]any{"Running": false}
	change, err := bridge.PrepareChange(context.Background(), rows[0].ContainerID, "request", seam.AgentDatabaseChange{Action: "create", Name: "archive", ExpectedRevision: containerRevision(rows)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = change(context.Background())
	var receipt *seam.AgentContainerError
	if !errors.As(err, &receipt) || !receipt.NoBusinessEffect || receipt.NotDispatched || receipt.Message != "数据库容器未运行，数据库变更未执行" {
		t.Fatalf("%+v %v", receipt, err)
	}
	after, _ := fixture.registry.list()
	if containerRevision(rows) != containerRevision(after) {
		t.Fatal("rejected creation changed registration")
	}
}

func TestContainerBridgeDistinguishesAcceptedNoEffectFromUnknownDrop(t *testing.T) {
	for _, stopped := range []bool{true, false} {
		t.Run(fmt.Sprint(stopped), func(t *testing.T) {
			fixture := newServiceFixture("8.4")
			bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
			create, _, err := bridge.PrepareCreate(context.Background(), seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}, testImageID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = create(context.Background()); err != nil {
				t.Fatal(err)
			}
			rows, _ := fixture.registry.list()
			before := containerRevision(rows)
			fixture.docker.inspectInfos[rows[0].ContainerID]["State"] = map[string]any{"Running": !stopped}
			fixture.protocol.dropErr = errors.New("PRIVATE_DATABASE_RESPONSE")
			remove, err := bridge.PrepareChange(context.Background(), rows[0].ContainerID, "request", seam.AgentDatabaseChange{Action: "remove", Name: "orders", ExpectedRevision: before})
			if err != nil {
				t.Fatal(err)
			}
			_, err = remove(context.Background())
			var receipt *seam.AgentContainerError
			if !errors.As(err, &receipt) || receipt.NotDispatched || receipt.NoBusinessEffect != stopped || strings.Contains(receipt.Message, "PRIVATE") {
				t.Fatalf("receipt=%+v %v", receipt, err)
			}
			if stopped && receipt.Message != "数据库容器未运行，数据库变更未执行" {
				t.Fatal(receipt.Message)
			}
			after, _ := fixture.registry.list()
			if containerRevision(after) != before {
				t.Fatal("failed change modified registration")
			}
			for _, call := range fixture.protocol.trace.items {
				if stopped && call == "drop" {
					t.Fatal("stopped container reached drop")
				}
			}
		})
	}
}

func TestContainerBridgeCreatesAndSynchronizesAllThreeEngines(t *testing.T) {
	for _, test := range []struct{ engine, repo, version, key, name string }{{engineMySQL, "mysql", "8.4", "MYSQL_DATABASE", "orders"}, {engineMariaDB, "mariadb", "11.4", "MARIADB_DATABASE", "orders"}, {engineRedis, "redis", "7.4", "", "0"}} {
		t.Run(test.engine, func(t *testing.T) {
			fixture := newServiceFixture(test.version)
			facade := &AgentFacade{service: fixture.service}
			checks := 0
			bridge := facade.ContainerBridge(func(context.Context) error { checks++; return nil })
			input := seam.AgentServiceContainerInput{Name: "service-main", Image: test.repo + ":" + test.version + "@sha256:" + strings.Repeat("a", 64), ResourceTier: "medium", NetworkScope: "container-net"}
			if test.key != "" {
				input.Env = []string{test.key + "=" + test.name}
			}
			run, handled, err := bridge.PrepareCreate(context.Background(), input, "sha256:"+testImageID)
			if err != nil || !handled || len(fixture.registry.rows) != 0 {
				t.Fatalf("prepare dispatched: %v %v", handled, err)
			}
			value, err := run(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if checks != 1 {
				t.Fatalf("authorization duplicated: %d", checks)
			}
			rows, err := fixture.registry.list()
			if err != nil || len(rows) != 1 {
				t.Fatalf("rows=%+v %v", rows, err)
			}
			row := rows[0]
			if row.Name != test.name || row.Engine != test.engine || row.State != stateActive || row.User.Password == "" || row.Admin.Password == "" {
				t.Fatalf("invalid registration: %s", row.ID)
			}
			raw, _ := json.Marshal(value)
			if strings.Contains(string(raw), row.User.Password) || strings.Contains(string(raw), row.Admin.Password) {
				t.Fatal("credential leaked")
			}
			if len(fixture.docker.createCalls) != 1 || fixture.docker.createCalls[0].serviceOptions == nil || fixture.docker.createCalls[0].imageID != testImageID {
				t.Fatal("resource options lost")
			}
		})
	}
}

func TestContainerBridgeStructuredChangeUsesRevisionAndOriginalCredentials(t *testing.T) {
	fixture := newServiceFixture("8.4")
	facade := &AgentFacade{service: fixture.service}
	bridge := facade.ContainerBridge(func(context.Context) error { return nil })
	input := seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}
	create, _, err := bridge.PrepareCreate(context.Background(), input, testImageID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := create(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	container := rows[0].ContainerID
	original := rows[0]
	if _, err := bridge.PrepareChange(context.Background(), container, "", seam.AgentDatabaseChange{Action: "create", Name: "archive", ExpectedRevision: "stale"}); err == nil {
		t.Fatal("stale revision accepted")
	}
	change := seam.AgentDatabaseChange{Action: "create", Name: "archive", ExpectedRevision: containerRevision(rows)}
	run, err := bridge.PrepareChange(context.Background(), container, "", change)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ = fixture.registry.list()
	if len(rows) != 2 || rows[1].Admin != original.Admin || rows[1].ContainerID != container {
		t.Fatal("new logical database lost shared instance credentials")
	}
	if _, err := run(context.Background()); err == nil {
		t.Fatal("stale prepared change replayed")
	}
	remove, err := bridge.PrepareChange(context.Background(), container, "", seam.AgentDatabaseChange{Action: "remove", Name: "archive", ExpectedRevision: containerRevision(rows)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remove(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ = fixture.registry.list()
	if len(rows) != 1 || rows[0].Name != "orders" || rows[0].User != original.User {
		t.Fatal("removed sibling affected original registration")
	}
}

func TestContainerOperationGuardBlocksSharedDatabaseWritesButSkipsOwnTask(t *testing.T) {
	fixture := newServiceFixture("8.4")
	facade := &AgentFacade{service: fixture.service}
	bridge := facade.ContainerBridge(func(context.Context) error { return nil })
	input := seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}
	create, _, err := bridge.PrepareCreate(context.Background(), input, testImageID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := create(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	container := rows[0].ContainerID
	guardError := errors.New("container operation pending")
	sawOwn := false
	fixture.service.operationGuard = func(_ context.Context, id, name, own string) error {
		if id != container || name != "db" {
			t.Fatalf("guard target mismatch id=%s name=%s", id, name)
		}
		if own == strings.Repeat("b", 64) {
			sawOwn = true
			return nil
		}
		return guardError
	}
	if err := fixture.service.Remove(context.Background(), rows[0].ID); !errors.Is(err, guardError) {
		t.Fatalf("HTTP page write bypassed pending barrier: %v", err)
	}
	change, err := bridge.PrepareChange(context.Background(), container, strings.Repeat("b", 64), seam.AgentDatabaseChange{Action: "create", Name: "archive", ExpectedRevision: containerRevision(rows)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := change(context.Background()); err != nil || !sawOwn {
		t.Fatalf("accepted worker did not retain own request identity: %v", err)
	}
}

func TestContainerInspectionDefaultsToBoundedRegistrationWithoutProtocolReads(t *testing.T) {
	fixture := newServiceFixture("8.4")
	for i := 0; i < 140; i++ {
		if err := fixture.registry.put(databaseRecord{ID: fmt.Sprintf("db-%03d", i), ContainerID: strings.Repeat("c", 64), Name: fmt.Sprintf("orders_%d", i), Engine: engineMySQL, State: stateActive, Source: sourceManaged, Admin: databaseSecret{Password: "PRIVATE_ADMIN"}, User: databaseSecret{Password: "PRIVATE_USER"}}); err != nil {
			t.Fatal(err)
		}
	}
	bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
	value, err := bridge.Inspect(context.Background(), strings.Repeat("c", 64), nil)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	if len(result["databases"].([]any)) != 100 || result["truncated"] != true || len(fixture.protocol.trace.items) != 0 {
		t.Fatalf("default inspection read protocol or exceeded bound: %+v", result)
	}
	raw, _ := json.Marshal(result)
	if len(raw) > 64<<10 || strings.Contains(string(raw), "PRIVATE_") || strings.Contains(string(raw), "metadata") || strings.Contains(string(raw), "metrics") {
		t.Fatal("default inspection exposed excess details")
	}
	if _, err := bridge.Inspect(context.Background(), strings.Repeat("c", 64), &seam.AgentDatabaseInspection{ID: "foreign-id", Metrics: true}); err == nil || len(fixture.protocol.trace.items) != 0 {
		t.Fatal("foreign database selection crossed container identity")
	}
}

type existingDatabaseProtocol struct{ *fakeProtocol }

func (p *existingDatabaseProtocol) exists(context.Context, databaseRecord, databaseAddress, string) (bool, error) {
	return true, nil
}

func TestContainerChangeDoesNotAdoptExistingUnregisteredLogicalDatabase(t *testing.T) {
	fixture := newServiceFixture("8.4")
	bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
	create, _, err := bridge.PrepareCreate(context.Background(), seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}, testImageID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := create(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	fixture.service.deps.protocol = &existingDatabaseProtocol{fixture.protocol}
	run, err := bridge.PrepareChange(context.Background(), rows[0].ContainerID, "", seam.AgentDatabaseChange{Action: "create", Name: "archive", ExpectedRevision: containerRevision(rows)})
	if err != nil {
		t.Fatal(err)
	}
	prior := len(fixture.protocol.trace.items)
	if _, err := run(context.Background()); err == nil {
		t.Fatal("unregistered existing database was adopted")
	}
	current, _ := fixture.registry.list()
	if len(current) != len(rows) || len(fixture.protocol.trace.items) != prior {
		t.Fatal("rejected adoption changed database state")
	}
}

func TestContainerCreateRejectsUnverifiableVariantsAndUnsupportedInitBeforeDispatch(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*seam.AgentServiceContainerInput)
	}{
		{"mysql-no-tag", func(input *seam.AgentServiceContainerInput) { input.Image = "mysql@sha256:" + strings.Repeat("a", 64) }},
		{"mariadb-no-tag", func(input *seam.AgentServiceContainerInput) {
			input.Image = "docker.io/library/mariadb@sha256:" + strings.Repeat("a", 64)
		}},
		{"redis-no-tag", func(input *seam.AgentServiceContainerInput) { input.Image = "redis@sha256:" + strings.Repeat("a", 64) }},
		{"mysql-variant", func(input *seam.AgentServiceContainerInput) {
			input.Image = "mysql:8.4-oracle@sha256:" + strings.Repeat("a", 64)
		}},
		{"redis-variant", func(input *seam.AgentServiceContainerInput) {
			input.Image = "redis:7.4-alpine@sha256:" + strings.Repeat("a", 64)
		}},
		{"credential-mismatch", func(input *seam.AgentServiceContainerInput) { input.Credentials = []string{"MARIADB_ROOT_PASSWORD"} }},
		{"hidden-init", func(input *seam.AgentServiceContainerInput) { input.Env = append(input.Env, "MYSQL_USER=manual_user") }},
		{"custom-port", func(input *seam.AgentServiceContainerInput) { input.Port = 3307 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newServiceFixture("8.4")
			bridge := (&AgentFacade{service: fixture.service}).ContainerBridge(func(context.Context) error { return nil })
			input := seam.AgentServiceContainerInput{Name: "db", Image: "mysql:8.4@sha256:" + strings.Repeat("a", 64), Env: []string{"MYSQL_DATABASE=orders"}}
			test.mutate(&input)
			if run, handled, err := bridge.PrepareCreate(context.Background(), input, testImageID); err == nil || !handled || run != nil || len(fixture.docker.createCalls) > 0 || len(fixture.registry.rows) > 0 {
				t.Fatalf("invalid input escaped preparation: handled=%v err=%v", handled, err)
			}
		})
	}
}
