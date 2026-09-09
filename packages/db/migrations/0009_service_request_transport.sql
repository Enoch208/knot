ALTER TABLE service_requests ADD COLUMN task_description text;

DROP TRIGGER service_requests_update_guard ON service_requests;

UPDATE service_requests
SET task_description = 'knot-json-base64url/1:' || rtrim(
  translate(replace(encode(request_bytes, 'base64'), E'\n', ''), '+/', '-_'),
  '='
);

ALTER TABLE service_requests ALTER COLUMN task_description SET NOT NULL;
ALTER TABLE service_requests DROP CONSTRAINT service_requests_transport_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_transport_check CHECK (
  transport = 'base64url' OR
  (transport = 'deflate-base64url' AND category IN ('rebalancing', 'grid', 'yield'))
);
ALTER TABLE service_requests ADD CONSTRAINT service_requests_task_description_shape CHECK (
  octet_length(convert_to(task_description, 'UTF8')) BETWEEN 1 AND 90000 AND
  (
    (transport = 'base64url' AND task_description ~ '^knot-json-base64url/1:[A-Za-z0-9_-]+$') OR
    (transport = 'deflate-base64url' AND task_description ~ '^knot-json-deflate-base64url/1:[A-Za-z0-9_-]+$')
  )
);
ALTER TABLE service_requests ADD CONSTRAINT service_requests_task_description_hash CHECK (
  task_description_sha256 = '0x' || encode(sha256(convert_to(task_description, 'UTF8')), 'hex')
);

CREATE TRIGGER service_requests_update_guard BEFORE UPDATE OR DELETE ON service_requests FOR EACH ROW EXECUTE FUNCTION knot_reject_service_request_mutation();

CREATE OR REPLACE FUNCTION knot_guard_service_request_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
DECLARE
  bound_snapshot_id text;
  bound_task_spec jsonb;
BEGIN
  IF NEW.task_description IS NULL AND NEW.transport = 'base64url' THEN
    NEW.task_description := 'knot-json-base64url/1:' || rtrim(
      translate(replace(encode(NEW.request_bytes, 'base64'), E'\n', ''), '+/', '-_'),
      '='
    );
  END IF;
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
