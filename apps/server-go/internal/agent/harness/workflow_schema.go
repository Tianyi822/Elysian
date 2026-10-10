package harness

const workflowSchema = `
CREATE TABLE workflow_definitions(id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,revision));
CREATE TABLE workflow_instances(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, canonical_input TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, ready_at TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE workflow_attempts(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 step_id TEXT NOT NULL, number INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
 state TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(workflow_id,step_id,number));
CREATE TABLE workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,seq INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(workflow_id,seq));
CREATE TABLE workflow_recoveries(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,request_id TEXT NOT NULL,canonical_input TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(workflow_id,request_id));
ALTER TABLE sessions ADD COLUMN active_workflow_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN workflow_id TEXT NOT NULL DEFAULT '';
CREATE INDEX runs_workflow ON runs(workflow_id);
ALTER TABLE approvals RENAME TO approvals_v3;
CREATE TABLE approvals(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,state TEXT NOT NULL,expires_at TEXT NOT NULL,document TEXT NOT NULL);
INSERT INTO approvals SELECT * FROM approvals_v3;
DROP TABLE approvals_v3;
CREATE UNIQUE INDEX approval_active_operation ON approvals(operation_id) WHERE state IN ('pending','approved');
CREATE INDEX workflow_ready ON workflow_instances(state,ready_at);
`
