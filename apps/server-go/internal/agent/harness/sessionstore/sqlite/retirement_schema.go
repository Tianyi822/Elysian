package sqlite

// Historical schema and record shapes are used only to upgrade pre-v11 databases.
const wikiSchema = `
CREATE TABLE IF NOT EXISTS wiki_spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_space_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_cleared_sources(run_id TEXT PRIMARY KEY,cleared_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_global_space ON wiki_spaces(kind) WHERE kind='global';
CREATE TABLE IF NOT EXISTS wiki_pages(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),slug TEXT NOT NULL,
 current_revision INTEGER NOT NULL,status TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(space_id,slug));
CREATE TABLE IF NOT EXISTS wiki_page_revisions(page_id TEXT NOT NULL REFERENCES wiki_pages(id),revision INTEGER NOT NULL,
 digest TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(page_id,revision));
CREATE TABLE IF NOT EXISTS wiki_candidates(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),state TEXT NOT NULL,
 origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_session_spaces(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_run_spaces(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_visible_pages(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,page_id));
CREATE TABLE IF NOT EXISTS wiki_recalls(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_task_contexts(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wiki_artifacts(kind TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',
 generation INTEGER NOT NULL DEFAULT 0,invalidated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS wiki_artifacts_task ON wiki_artifacts(task_id,invalidated);
CREATE TABLE IF NOT EXISTS wiki_dependencies(kind TEXT NOT NULL,id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
 PRIMARY KEY(kind,id,page_id,revision),FOREIGN KEY(kind,id) REFERENCES wiki_artifacts(kind,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS wiki_dependencies_page ON wiki_dependencies(page_id,revision);
CREATE TABLE IF NOT EXISTS wiki_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,
 state TEXT NOT NULL,document TEXT NOT NULL,input TEXT NOT NULL,UNIQUE(kind,origin_kind,origin_id));
CREATE INDEX IF NOT EXISTS wiki_jobs_state ON wiki_jobs(state);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(page_id UNINDEXED,space_id UNINDEXED,title,body,tokenize='unicode61');
` + embeddingSchema

const embeddingSchema = `
CREATE TABLE IF NOT EXISTS wiki_embedding_profiles(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,
 PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_embedding_indexes(page_id TEXT NOT NULL,page_revision INTEGER NOT NULL,digest TEXT NOT NULL,
 profile_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,vector TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(page_id,page_revision,profile_id,profile_revision));
CREATE INDEX IF NOT EXISTS wiki_embedding_page ON wiki_embedding_indexes(page_id,page_revision);
CREATE TABLE IF NOT EXISTS wiki_embedding_requests(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
`

var retiredWikiRecordSpecs = []recordSpec{
	{"wiki_session_spaces", "ROW.session_id", "ROW.session_id", "''"},
	{"wiki_run_spaces", "ROW.run_id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"wiki_recalls", "ROW.run_id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"wiki_task_contexts", "ROW.task_id", "(SELECT session_id FROM tasks WHERE id=ROW.task_id)", "''"},
	{"wiki_visible_pages", "ROW.owner_kind || ':' || ROW.owner_id || ':' || ROW.page_id", "CASE WHEN ROW.owner_kind='workflow' THEN (SELECT session_id FROM workflow_instances WHERE id=ROW.owner_id) ELSE (SELECT session_id FROM runs WHERE id=ROW.owner_id) END", "CASE WHEN ROW.owner_kind='run' THEN ROW.owner_id ELSE '' END"},
	{"wiki_artifacts", "ROW.kind || ':' || ROW.id", "COALESCE((SELECT session_id FROM tasks WHERE id=ROW.task_id),(SELECT session_id FROM runs WHERE id=ROW.run_id))", "ROW.run_id"},
	{"wiki_dependencies", "ROW.kind || ':' || ROW.id || ':' || ROW.page_id || ':' || ROW.revision", "(SELECT t.session_id FROM wiki_artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.kind=ROW.kind AND a.id=ROW.id)", "(SELECT run_id FROM wiki_artifacts WHERE kind=ROW.kind AND id=ROW.id)"},
	{"wiki_jobs", "ROW.id", "(SELECT session_id FROM tasks WHERE id=json_extract(ROW.document,'$.taskId'))", "COALESCE(json_extract(ROW.document,'$.runId'),'')"},
}

// Pending rows authorize one replica replacement after the SQLite commit.
const retirementSchema = `
CREATE TABLE context_exclusions(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE agent_record_rebuild(
 owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,old_digest TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id)
);
`

const retiredWikiTables = `
DROP TABLE IF EXISTS wiki_fts;
DROP TABLE IF EXISTS wiki_embedding_requests;
DROP TABLE IF EXISTS wiki_embedding_indexes;
DROP TABLE IF EXISTS wiki_embedding_profiles;
DROP TABLE IF EXISTS wiki_dependencies;
DROP TABLE IF EXISTS wiki_artifacts;
DROP TABLE IF EXISTS wiki_candidates;
DROP TABLE IF EXISTS wiki_page_revisions;
DROP TABLE IF EXISTS wiki_pages;
DROP TABLE IF EXISTS wiki_space_revisions;
DROP TABLE IF EXISTS wiki_spaces;
DROP TABLE IF EXISTS wiki_run_spaces;
DROP TABLE IF EXISTS wiki_session_spaces;
DROP TABLE IF EXISTS wiki_visible_pages;
DROP TABLE IF EXISTS wiki_recalls;
DROP TABLE IF EXISTS wiki_task_contexts;
DROP TABLE IF EXISTS wiki_cleared_sources;
DROP TABLE IF EXISTS wiki_jobs;
`

// Only identifiers of records excluded from future use survive the migration.
// Completed runs that merely had a tool available retain their usable history.
const legacyContextExclusions = `
INSERT OR IGNORE INTO context_exclusions
 SELECT a.kind,a.id FROM wiki_artifacts a
 WHERE a.kind IN ('run','message','memory','workspace','model-request','operation','workflow','workflow-node','workflow-scope')
 AND (a.invalidated=1 OR EXISTS(SELECT 1 FROM wiki_dependencies d WHERE d.kind=a.kind AND d.id=a.id));
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',a.run_id FROM wiki_artifacts a JOIN context_exclusions x ON x.kind=a.kind AND x.id=a.id WHERE a.run_id<>'';
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',run_id FROM wiki_recalls WHERE json_array_length(document,'$.sources')>0;
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',run_id FROM model_requests
 WHERE json_array_length(document,'$.wikiSources')>0;
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',run_id FROM messages WHERE role='assistant' AND
 (json_array_length(document,'$.wikiSources')>0 OR json_extract(document,'$.quarantined')=1);
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',run_id FROM operations
 WHERE json_extract(document,'$.capability.source')='wiki' AND state IN ('completed','unknown','waiting-task','dispatched');
INSERT OR IGNORE INTO context_exclusions
 SELECT 'message',id FROM messages WHERE role='assistant' AND
 (json_array_length(document,'$.wikiSources')>0 OR json_extract(document,'$.quarantined')=1
  OR EXISTS(SELECT 1 FROM context_exclusions x WHERE x.kind='run' AND x.id=messages.run_id));

INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',r.id FROM runs r WHERE r.state NOT IN ('succeeded','failed','cancelled','interrupted') AND
 (json_extract(r.document,'$.wikiStrategy')='navigation/v1'
  OR EXISTS(SELECT 1 FROM json_each(r.document,'$.snapshot.tools') t WHERE json_extract(t.value,'$.source')='wiki')
  OR EXISTS(SELECT 1 FROM json_each(r.document,'$.snapshot.materials') t WHERE json_extract(t.value,'$.source')='wiki')
  OR EXISTS(SELECT 1 FROM wiki_run_spaces w WHERE w.run_id=r.id AND json_array_length(w.document)>0)
  OR EXISTS(SELECT 1 FROM operations o WHERE o.run_id=r.id AND json_extract(o.document,'$.capability.source')='wiki'));

INSERT OR IGNORE INTO context_exclusions
 SELECT 'workflow',w.id FROM workflow_instances w
 WHERE EXISTS(SELECT 1 FROM wiki_visible_pages v WHERE v.owner_kind='workflow' AND v.owner_id=w.id)
 OR EXISTS(SELECT 1 FROM runs r JOIN context_exclusions x ON x.kind='run' AND x.id=r.id WHERE r.workflow_id=w.id)
 OR EXISTS(SELECT 1 FROM workflow_nodes n JOIN context_exclusions x ON x.kind='workflow-node' AND x.id=n.id WHERE n.workflow_id=w.id)
 OR EXISTS(SELECT 1 FROM workflow_scopes c JOIN context_exclusions x ON x.kind='workflow-scope' AND x.id=c.id WHERE c.workflow_id=w.id)
 OR EXISTS(SELECT 1 FROM wiki_artifacts a JOIN context_exclusions x ON x.kind=a.kind AND x.id=a.id
   WHERE a.kind IN ('memory','workspace') AND (a.task_id=json_extract(w.document,'$.taskId')
    OR EXISTS(SELECT 1 FROM workflow_scopes c WHERE c.workflow_id=w.id AND c.task_id=a.task_id)));
INSERT OR IGNORE INTO context_exclusions
 SELECT 'run',r.id FROM runs r JOIN context_exclusions x ON x.kind='workflow' AND x.id=r.workflow_id
 WHERE r.state NOT IN ('succeeded','failed','cancelled','interrupted');
`
