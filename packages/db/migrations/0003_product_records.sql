CREATE TABLE endpoint_observations (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  endpoint text NOT NULL,
  request_type text NOT NULL,
  result text NOT NULL CHECK (result IN ('SUCCESS', 'UNSUPPORTED', 'UNAVAILABLE', 'INVALID')),
  latency_milliseconds integer CHECK (latency_milliseconds >= 0),
  safe_details jsonb NOT NULL CHECK (jsonb_typeof(safe_details) = 'object'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auditions (
  id text PRIMARY KEY,
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id),
  snapshot_id text REFERENCES snapshots(id),
  sharing_policy jsonb NOT NULL CHECK (jsonb_typeof(sharing_policy) = 'object'),
  cost_policy jsonb NOT NULL CHECK (jsonb_typeof(cost_policy) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer, endpoint, idempotency_key)
);

CREATE TABLE candidate_runs (
  id text PRIMARY KEY,
  audition_id text NOT NULL REFERENCES auditions(id),
  agent_id text NOT NULL REFERENCES agents(id),
  operator_relation text NOT NULL,
  raw_artifact_id text,
  elapsed_milliseconds integer CHECK (elapsed_milliseconds >= 0),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audition_id, agent_id)
);

CREATE TABLE evaluations (
  id text PRIMARY KEY,
  candidate_run_id text NOT NULL REFERENCES candidate_runs(id),
  checker_version text NOT NULL,
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  tolerances jsonb NOT NULL CHECK (jsonb_typeof(tolerances) = 'object'),
  eligible boolean NOT NULL,
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_run_id, checker_version)
);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  job_id text REFERENCES jobs(id),
  task_id text NOT NULL REFERENCES tasks(id),
  media_type text NOT NULL,
  byte_hash text NOT NULL CHECK (byte_hash ~ '^0x[0-9a-fA-F]{64}$'),
  storage_uri text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('PRIVATE', 'SHARED', 'PUBLIC')),
  retention_until timestamptz NOT NULL,
  source_linkage jsonb NOT NULL CHECK (jsonb_typeof(source_linkage) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (byte_hash, storage_uri)
);

ALTER TABLE candidate_runs ADD CONSTRAINT candidate_runs_artifact_fk FOREIGN KEY (raw_artifact_id) REFERENCES artifacts(id);

CREATE TABLE benchmark_runs (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  snapshot_id text REFERENCES snapshots(id),
  evaluator_version text NOT NULL,
  agent_measurement jsonb NOT NULL CHECK (jsonb_typeof(agent_measurement) = 'object'),
  reference_measurement jsonb NOT NULL CHECK (jsonb_typeof(reference_measurement) = 'object'),
  costs jsonb NOT NULL CHECK (jsonb_typeof(costs) = 'object'),
  quality jsonb NOT NULL CHECK (jsonb_typeof(quality) = 'object'),
  inclusion_rationale text NOT NULL,
  exclusion_rationale text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE claims (
  id text PRIMARY KEY,
  assertion text NOT NULL,
  evidence_class text NOT NULL CHECK (evidence_class IN ('mainnet_observation', 'testnet_observation', 'historical_replay', 'synthetic_fixture', 'publisher_claim')),
  status text NOT NULL CHECK (status IN ('SUPPORTED', 'PARTIAL', 'UNMEASURED', 'NOT_CLAIMED')),
  evidence_artifact_id text REFERENCES artifacts(id),
  limitation text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
