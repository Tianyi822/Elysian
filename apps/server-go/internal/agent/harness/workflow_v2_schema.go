package harness

const workflowV2Schema = `
CREATE TABLE IF NOT EXISTS workflow_scopes(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 parent_node_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),ordinal INTEGER NOT NULL,state TEXT NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_scopes_parent ON workflow_scopes(parent_node_id,ordinal);
CREATE TABLE IF NOT EXISTS workflow_nodes(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 scope_id TEXT NOT NULL REFERENCES workflow_scopes(id) ON DELETE CASCADE,step_id TEXT NOT NULL,
 state TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(scope_id,step_id));
CREATE INDEX IF NOT EXISTS workflow_nodes_ready ON workflow_nodes(workflow_id,state);
`
