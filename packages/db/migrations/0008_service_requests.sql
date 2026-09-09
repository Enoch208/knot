ALTER TABLE tasks ADD CONSTRAINT tasks_service_request_identity UNIQUE (id, buyer, category, input_hash);

CREATE TABLE service_requests (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 2048 AND endpoint ~ '^https://'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  task_id text NOT NULL,
  task_spec_binding jsonb NOT NULL CHECK (jsonb_typeof(task_spec_binding) = 'object'),
  category text NOT NULL CHECK (category IN ('rebalancing', 'grid', 'yield', 'health')),
  request_schema_version text NOT NULL,
  transport text NOT NULL CHECK (transport = 'base64url'),
  request_bytes bytea NOT NULL CHECK (octet_length(request_bytes) BETWEEN 1 AND 65536),
  request_sha256 text GENERATED ALWAYS AS ('0x' || encode(sha256(request_bytes), 'hex')) STORED,
  request_keccak256 text NOT NULL CHECK (request_keccak256 ~ '^0x[0-9a-f]{64}$'),
  task_description_sha256 text NOT NULL CHECK (task_description_sha256 ~ '^0x[0-9a-f]{64}$'),
  snapshot_id text NOT NULL,
  task_input_hash text NOT NULL CHECK (task_input_hash ~ '^0x[0-9a-f]{64}$'),
  input_binding text NOT NULL CHECK (input_binding IN ('EXACT_REQUEST_BYTES', 'LEGACY_EMBEDDED_TASK')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer, endpoint, idempotency_key),
  FOREIGN KEY (task_id, buyer, category, task_input_hash) REFERENCES tasks (id, buyer, category, input_hash),
  CHECK ((category = 'health' AND request_schema_version = 'knot.health.request/1') OR (category = 'rebalancing' AND request_schema_version = 'knot.rangepilot.request/1') OR (category = 'grid' AND request_schema_version = 'knot.gridquant.request/2') OR (category = 'yield' AND request_schema_version = 'knot.yield.request/2')),
  CHECK ((input_binding = 'EXACT_REQUEST_BYTES' AND category <> 'health' AND request_keccak256 = task_input_hash) OR (input_binding = 'LEGACY_EMBEDDED_TASK' AND category = 'health'))
);

CREATE FUNCTION knot_guard_service_request_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
DECLARE
  bound_snapshot_id text;
  bound_task_spec jsonb;
BEGIN
  SELECT task_spec->>'snapshotId', task_spec INTO bound_snapshot_id, bound_task_spec
  FROM tasks
  WHERE id = NEW.task_id
    AND buyer = NEW.buyer
    AND category = NEW.category
    AND input_hash = NEW.task_input_hash
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service request task binding is invalid';
  END IF;
  IF bound_snapshot_id IS DISTINCT FROM NEW.snapshot_id THEN
    RAISE EXCEPTION 'service request snapshot binding is invalid';
  END IF;
  IF bound_task_spec IS DISTINCT FROM NEW.task_spec_binding THEN
    RAISE EXCEPTION 'service request task specification binding is invalid';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER service_requests_insert_guard BEFORE INSERT ON service_requests FOR EACH ROW EXECUTE FUNCTION knot_guard_service_request_insert();

CREATE FUNCTION knot_reject_service_request_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'service requests are append-only';
END
$body$;

CREATE TRIGGER service_requests_update_guard BEFORE UPDATE OR DELETE ON service_requests FOR EACH ROW EXECUTE FUNCTION knot_reject_service_request_mutation();
CREATE TRIGGER service_requests_truncate_guard BEFORE TRUNCATE ON service_requests FOR EACH STATEMENT EXECUTE FUNCTION knot_reject_service_request_mutation();

CREATE FUNCTION knot_guard_bound_task_update() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM service_requests WHERE task_id = OLD.id) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'task with a service request binding is immutable';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER tasks_service_request_guard BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION knot_guard_bound_task_update();
