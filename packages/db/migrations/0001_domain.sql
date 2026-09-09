CREATE TABLE agents (
  id text PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  registry text NOT NULL CHECK (registry ~ '^0x[0-9a-f]{40}$'),
  agent_id numeric(78, 0) NOT NULL CHECK (agent_id >= 0),
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  operator_relation text NOT NULL,
  metadata_hash text NOT NULL CHECK (metadata_hash ~ '^0x[0-9a-fA-F]{64}$'),
  status text NOT NULL CHECK (status IN ('INDEXED', 'CALLABLE', 'TASK_COMPATIBLE', 'HIREABLE', 'EXECUTION_ENABLED', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, registry, agent_id)
);

CREATE TABLE agent_capabilities (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  task_schema_version text NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  capability text NOT NULL CHECK (capability IN ('analysis', 'monitoring', 'execution')),
  conformance_artifact_hash text NOT NULL CHECK (conformance_artifact_hash ~ '^0x[0-9a-fA-F]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, task_schema_version, chain_id, capability)
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  schema_version text NOT NULL CHECK (schema_version = 'knot.task/1'),
  category text NOT NULL CHECK (category IN ('rebalancing', 'grid', 'yield', 'health', 'security')),
  capability text NOT NULL CHECK (capability IN ('analysis', 'monitoring', 'execution')),
  identity_chain_id integer NOT NULL CHECK (identity_chain_id IN (56, 97)),
  data_chain_id integer NOT NULL CHECK (data_chain_id IN (56, 97)),
  payment_chain_id integer NOT NULL CHECK (payment_chain_id IN (56, 97)),
  execution_chain_id integer CHECK (execution_chain_id IN (56, 97)),
  input_hash text NOT NULL CHECK (input_hash ~ '^0x[0-9a-fA-F]{64}$'),
  task_spec jsonb NOT NULL CHECK (jsonb_typeof(task_spec) = 'object'),
  access_scope jsonb NOT NULL CHECK (jsonb_typeof(access_scope) = 'object'),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (execution_chain_id IS NULL OR execution_chain_id = data_chain_id),
  CHECK ((capability = 'execution') = (execution_chain_id IS NOT NULL))
);

CREATE TABLE snapshots (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  block_number numeric(78, 0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^0x[0-9a-fA-F]{64}$'),
  canonicality text NOT NULL CHECK (canonicality IN ('confirmed', 'unconfirmed', 'orphaned')),
  source_manifest jsonb NOT NULL CHECK (jsonb_typeof(source_manifest) = 'array'),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  provider_agent_id text NOT NULL REFERENCES agents(id),
  issuer_domain text NOT NULL,
  quote_nonce text NOT NULL,
  task_hash text NOT NULL CHECK (task_hash ~ '^0x[0-9a-fA-F]{64}$'),
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units >= 0),
  token_decimals integer NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer_domain, quote_nonce)
);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id),
  quote_id text NOT NULL REFERENCES quotes(id),
  chain_id integer CHECK (chain_id IN (56, 97)),
  commerce text CHECK (commerce IS NULL OR commerce ~ '^0x[0-9a-f]{40}$'),
  chain_job_id numeric(78, 0) CHECK (chain_job_id >= 0),
  work_state text NOT NULL CHECK (work_state IN ('DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_OBSERVED', 'RUNNING', 'OUTPUT_RECEIVED', 'OUTPUT_CHECKED', 'FAILED', 'EXPIRED', 'CANCELED')),
  financial_state text NOT NULL CHECK (financial_state IN ('UNFUNDED', 'FUNDING_PENDING', 'ESCROWED', 'RESOLUTION_PENDING', 'PAID', 'REFUNDED', 'UNKNOWN')),
  protocol_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(protocol_state) = 'object'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer, endpoint, idempotency_key),
  CHECK ((chain_id IS NULL) = (commerce IS NULL)),
  CHECK ((chain_id IS NULL) = (chain_job_id IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE UNIQUE INDEX jobs_chain_identity ON jobs (chain_id, commerce, chain_job_id) WHERE chain_job_id IS NOT NULL;

CREATE TABLE sessions (
  id text PRIMARY KEY,
  owner_address text NOT NULL CHECK (owner_address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'object'),
  secret_reference text NOT NULL,
  epoch integer NOT NULL CHECK (epoch >= 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_events (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, sequence)
);

CREATE TABLE outbox (
  id text PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_sequence integer NOT NULL CHECK (aggregate_sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_sequence),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX outbox_available ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE chain_actions (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id),
  session_id text NOT NULL REFERENCES sessions(id),
  task_id text NOT NULL REFERENCES tasks(id),
  action_sequence integer NOT NULL CHECK (action_sequence >= 0),
  semantic_action text NOT NULL,
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  account_address text NOT NULL CHECK (account_address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer NOT NULL CHECK (chain_id IN (56, 97)),
  nonce numeric(78, 0) CHECK (nonce >= 0),
  relay_intent_id text,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  state text NOT NULL CHECK (state IN ('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reconciliation) = 'object'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, task_id, action_sequence),
  CHECK (nonce IS NOT NULL OR relay_intent_id IS NOT NULL)
);

CREATE UNIQUE INDEX chain_actions_nonce ON chain_actions (chain_id, signer_address, nonce) WHERE nonce IS NOT NULL;
