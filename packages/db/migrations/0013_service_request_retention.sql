ALTER TABLE service_requests
  ADD COLUMN retention_until timestamptz,
  ADD COLUMN erased_at timestamptz,
  ADD COLUMN erased_request_sha256 text
    CHECK (erased_request_sha256 IS NULL OR erased_request_sha256 ~ '^0x[0-9a-f]{64}$');

ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_erasure_digest
    CHECK ((erased_at IS NULL AND erased_request_sha256 IS NULL)
        OR (erased_at IS NOT NULL AND erased_request_sha256 IS NOT NULL));

ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_erasure_requires_retention
    CHECK (erased_at IS NULL OR retention_until IS NOT NULL);

CREATE OR REPLACE FUNCTION knot_reject_service_request_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.erased_at IS NULL
     AND NEW.erased_at IS NOT NULL
     AND OLD.retention_until IS NOT NULL
     AND NEW.erased_at >= OLD.retention_until
     AND NEW.erased_request_sha256 = OLD.request_sha256
     AND NEW.request_bytes = '\x00'::bytea
     AND OLD.request_bytes <> '\x00'::bytea
     AND NEW.id = OLD.id
     AND NEW.buyer = OLD.buyer
     AND NEW.endpoint = OLD.endpoint
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.task_id = OLD.task_id
     AND NEW.task_spec_binding = OLD.task_spec_binding
     AND NEW.category = OLD.category
     AND NEW.request_schema_version = OLD.request_schema_version
     AND NEW.transport = OLD.transport
     AND NEW.request_keccak256 = OLD.request_keccak256
     AND NEW.task_description_sha256 = OLD.task_description_sha256
     AND NEW.snapshot_id = OLD.snapshot_id
     AND NEW.task_input_hash = OLD.task_input_hash
     AND NEW.input_binding = OLD.input_binding
     AND NEW.created_at = OLD.created_at
     AND NEW.retention_until = OLD.retention_until
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'service requests are append-only';
END
$body$;

CREATE FUNCTION knot_erase_expired_service_requests(cutoff timestamptz)
RETURNS TABLE (erased_id text, preserved_sha256 text)
LANGUAGE plpgsql AS $body$
BEGIN
  RETURN QUERY
  UPDATE service_requests
     SET request_bytes = '\x00'::bytea,
         erased_request_sha256 = request_sha256,
         erased_at = cutoff
   WHERE erased_at IS NULL
     AND retention_until IS NOT NULL
     AND retention_until <= cutoff
     AND request_bytes <> '\x00'::bytea
  RETURNING id, erased_request_sha256;
END
$body$;
