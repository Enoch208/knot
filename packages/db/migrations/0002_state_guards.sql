CREATE FUNCTION knot_valid_work_transition(current_state text, next_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $body$
  SELECT current_state = next_state OR (current_state, next_state) IN (
    ('DRAFT', 'QUOTED'), ('DRAFT', 'CANCELED'), ('DRAFT', 'EXPIRED'),
    ('QUOTED', 'AWAITING_PAYMENT'), ('QUOTED', 'CANCELED'), ('QUOTED', 'EXPIRED'),
    ('AWAITING_PAYMENT', 'PAYMENT_OBSERVED'), ('AWAITING_PAYMENT', 'FAILED'),
    ('AWAITING_PAYMENT', 'CANCELED'), ('AWAITING_PAYMENT', 'EXPIRED'),
    ('PAYMENT_OBSERVED', 'RUNNING'), ('PAYMENT_OBSERVED', 'FAILED'),
    ('RUNNING', 'OUTPUT_RECEIVED'), ('RUNNING', 'FAILED'),
    ('OUTPUT_RECEIVED', 'OUTPUT_CHECKED'), ('OUTPUT_RECEIVED', 'FAILED')
  )
$body$;

CREATE FUNCTION knot_valid_financial_transition(current_state text, next_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $body$
  SELECT current_state = next_state OR (current_state, next_state) IN (
    ('UNFUNDED', 'FUNDING_PENDING'),
    ('FUNDING_PENDING', 'UNFUNDED'), ('FUNDING_PENDING', 'ESCROWED'), ('FUNDING_PENDING', 'UNKNOWN'),
    ('ESCROWED', 'RESOLUTION_PENDING'), ('ESCROWED', 'PAID'), ('ESCROWED', 'REFUNDED'), ('ESCROWED', 'UNKNOWN'),
    ('RESOLUTION_PENDING', 'PAID'), ('RESOLUTION_PENDING', 'REFUNDED'), ('RESOLUTION_PENDING', 'UNKNOWN'),
    ('UNKNOWN', 'UNFUNDED'), ('UNKNOWN', 'FUNDING_PENDING'), ('UNKNOWN', 'ESCROWED'),
    ('UNKNOWN', 'RESOLUTION_PENDING'), ('UNKNOWN', 'PAID'), ('UNKNOWN', 'REFUNDED')
  )
$body$;

CREATE FUNCTION knot_guard_job_update() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT knot_valid_work_transition(OLD.work_state, NEW.work_state) THEN
    RAISE EXCEPTION 'invalid work state transition from % to %', OLD.work_state, NEW.work_state;
  END IF;
  IF NOT knot_valid_financial_transition(OLD.financial_state, NEW.financial_state) THEN
    RAISE EXCEPTION 'invalid financial state transition from % to %', OLD.financial_state, NEW.financial_state;
  END IF;
  IF OLD.work_state IN ('OUTPUT_CHECKED', 'FAILED', 'EXPIRED', 'CANCELED') AND NEW.work_state <> OLD.work_state THEN
    RAISE EXCEPTION 'finalized work state for job % is immutable', OLD.id;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'job version must increment exactly once';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END
$body$;

CREATE TRIGGER jobs_state_guard BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION knot_guard_job_update();

CREATE FUNCTION knot_valid_action_transition(current_state text, next_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $body$
  SELECT (current_state, next_state) IN (
    ('PREPARED', 'SUBMITTED'), ('PREPARED', 'FAILED'),
    ('SUBMITTED', 'CONFIRMED'), ('SUBMITTED', 'FAILED'), ('SUBMITTED', 'UNKNOWN'),
    ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED')
  )
$body$;

CREATE FUNCTION knot_guard_chain_action_update() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT knot_valid_action_transition(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'invalid chain action transition from % to %', OLD.state, NEW.state;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'chain action version must increment exactly once';
  END IF;
  IF OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS DISTINCT FROM OLD.transaction_hash THEN
    RAISE EXCEPTION 'submitted transaction hash is immutable';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END
$body$;

CREATE TRIGGER chain_actions_state_guard BEFORE UPDATE ON chain_actions FOR EACH ROW EXECUTE FUNCTION knot_guard_chain_action_update();
