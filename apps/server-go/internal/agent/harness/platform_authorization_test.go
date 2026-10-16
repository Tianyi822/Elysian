package harness

import (
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/tools"
)

func TestPlatformWriteGrantIsIndependentOfPermissionMode(t *testing.T) {
	operation := Operation{Capability: Capability{Name: "database_remove", Source: "builtin", Metadata: tools.Metadata{Exposure: "agent", ResourceType: "database", ResourceKeyArgument: "id"}}, ArgumentsJSON: `{"id":"db-1"}`}
	for _, mode := range []PermissionMode{PermissionAsk, PermissionAssist, PermissionFull} {
		for _, test := range []struct {
			name    string
			grant   execconfig.Grant
			allowed bool
		}{
			{"missing", execconfig.Grant{}, false},
			{"disabled", execconfig.Grant{Resources: []execconfig.Resource{{Domain: "database", ID: "db-1", Access: "write"}}}, false},
			{"read-only", execconfig.Grant{Enabled: true, Resources: []execconfig.Resource{{Domain: "database", ID: "db-1", Access: "read"}}}, false},
			{"different-id", execconfig.Grant{Enabled: true, Resources: []execconfig.Resource{{Domain: "database", ID: "db-2", Access: "write"}}}, false},
			{"different-domain", execconfig.Grant{Enabled: true, Resources: []execconfig.Resource{{Domain: "website", ID: "db-1", Access: "write"}}}, false},
			{"exact-write", execconfig.Grant{Enabled: true, Resources: []execconfig.Resource{{Domain: "database", ID: "db-1", Access: "write"}}}, true},
		} {
			t.Run(string(mode)+"/"+test.name, func(t *testing.T) {
				snapshot := CapabilitySnapshot{PermissionMode: mode, Grants: []execconfig.Grant{test.grant}}
				err := authorizeOperationScope(snapshot, operation)
				if (err == nil) != test.allowed {
					t.Fatalf("grant decision=%v allowed=%v", err, test.allowed)
				}
			})
		}
	}
}

func TestFilesRequireFixedDirectoryGrantsForEveryTarget(t *testing.T) {
	operation := Operation{Capability: Capability{Name: "file_move", Source: "builtin", Metadata: tools.Metadata{Exposure: "agent", ResourceType: "filesystem", ResourceKeyArgument: "root"}}, ArgumentsJSON: `{"root":"/srv/app","path":"a.txt","target":"b.txt"}`}
	snapshot := CapabilitySnapshot{PermissionMode: PermissionFull, Grants: []execconfig.Grant{{Enabled: true, Directories: []execconfig.Directory{{Path: "/srv/app", Access: "ro"}}}}}
	if authorizeOperationScope(snapshot, operation) == nil {
		t.Fatal("full mode bypassed read-only directory grant")
	}
	snapshot.Grants[0].Directories[0].Access = "rw"
	if err := authorizeOperationScope(snapshot, operation); err != nil {
		t.Fatal(err)
	}
	operation.ArgumentsJSON = `{"root":"/srv/app","path":"a.txt","target":"../../etc/passwd"}`
	if authorizeOperationScope(snapshot, operation) == nil {
		t.Fatal("move escaped authorized directory")
	}
	operation.Capability.Metadata.Exposure = "human"
	operation.ArgumentsJSON = `{"root":"/srv/app","path":"a.txt","target":"b.txt"}`
	if authorizeOperationScope(snapshot, operation) == nil {
		t.Fatal("full mode exposed human-only tool")
	}
}

func TestTaskCancellationOwnsControlLeaseWithoutReleasingTaskResource(t *testing.T) {
	c := Capability{Name: "website_deployment_cancel", Source: "builtin", Metadata: tools.Metadata{Exposure: "agent", Action: "cancel", Async: true, TaskDomain: "website", TaskIDArgument: "taskId", ResourceType: "website", ResourceKeyArgument: "id"}}
	claims, _ := operationResourceClaims(CapabilitySnapshot{}, Operation{Capability: c, ArgumentsJSON: `{"id":"site-1","taskId":"task-1"}`})
	if len(claims) != 1 || claims[0].Kind != "task-control" || claims[0].Key != "task-1" {
		t.Fatalf("cancel claim=%+v", claims)
	}
	if resourceSetsConflict(claims, []ResourceClaim{{Kind: "website", Authority: "platform", Key: "site-1", Access: "write"}}) {
		t.Fatal("cancel deadlocks behind the accepted task's own resource lease")
	}
	if resourceSetsConflict(claims, []ResourceClaim{{Kind: "filesystem", Authority: "local", Key: "/", Access: "write", Subtree: true}}) {
		t.Fatal("cancel deadlocks behind the accepted task's filesystem lease")
	}
	if !resourceSetsConflict(claims, claims) {
		t.Fatal("parallel cancellation calls are not serialized")
	}
}

func TestPlatformContentClaimsConflictWithHostFilesAndExecutionGrants(t *testing.T) {
	for _, domain := range []string{"website", "container-app"} {
		for _, readOnly := range []bool{true, false} {
			op := Operation{Capability: Capability{Name: "content", Source: "builtin", ReadOnly: readOnly, Metadata: tools.Metadata{Domain: domain, ResourceType: domain, ResourceKeyArgument: "id"}}, ArgumentsJSON: `{"id":"project"}`}
			claims, _ := operationResourceClaims(CapabilitySnapshot{}, op)
			for _, hostReadOnly := range []bool{true, false} {
				host := Operation{Capability: Capability{Name: "file", Source: "builtin", ReadOnly: hostReadOnly, Metadata: tools.Metadata{ResourceType: "filesystem", ResourceKeyArgument: "root"}}, ArgumentsJSON: `{"root":"/srv/project"}`}
				hostClaims, _ := operationResourceClaims(CapabilitySnapshot{}, host)
				want := !readOnly || !hostReadOnly
				if got := resourceSetsConflict(claims, hostClaims); got != want {
					t.Fatalf("%s read=%v hostRead=%v conflict=%v want=%v claims=%+v host=%+v", domain, readOnly, hostReadOnly, got, want, claims, hostClaims)
				}
			}
			bash := Operation{TaskID: "other-task", Capability: Capability{Name: BashExec, Source: BashSource}, ArgumentsJSON: `{}`, Execution: &ExecutionPlan{Grant: &execconfig.Grant{Directories: []execconfig.Directory{{Path: "/another/project", Access: "rw"}}}}}
			bashClaims, _ := operationResourceClaims(CapabilitySnapshot{}, bash)
			if !resourceSetsConflict(claims, bashClaims) {
				t.Fatalf("%s content access did not conflict with writable host execution grant", domain)
			}
		}
	}
}

func TestTaskObservationDoesNotWaitForSubmissionLease(t *testing.T) {
	for _, domain := range []string{"website", "container-app-build", "docker-image-pull", "database"} {
		original := []ResourceClaim{{Kind: "filesystem", Authority: "local", Key: "/", Access: "write", Subtree: true}, {Kind: domain, Authority: "local", Key: "/project", Access: "write"}}
		cancel := []ResourceClaim{{Kind: "task-control", Authority: domain, Key: "task-1", Access: "write"}}
		for _, action := range []string{"task_status", "task_logs", "task_list"} {
			capability := Capability{Name: action, Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Action: action, TaskDomain: domain, TaskIDArgument: "taskId", ResourceType: domain, ResourceKeyArgument: "id"}}
			claims, _ := operationResourceClaims(CapabilitySnapshot{}, Operation{Capability: capability, ArgumentsJSON: `{"id":"project","taskId":"task-1"}`})
			if resourceSetsConflict(claims, original) {
				t.Fatalf("%s/%s blocked behind accepted task resource: %+v", domain, action, claims)
			}
			if !resourceSetsConflict(claims, cancel) {
				t.Fatalf("%s/%s did not serialize with cancellation", domain, action)
			}
			if resourceSetsConflict(claims, claims) {
				t.Fatalf("%s/%s serialized read-only task observers", domain, action)
			}
		}
	}
}
