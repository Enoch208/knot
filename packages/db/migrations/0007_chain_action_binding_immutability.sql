CREATE OR REPLACE FUNCTION knot_guard_chain_action_update() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF ROW(
    OLD.id,
    OLD.job_id,
    OLD.session_id,
    OLD.task_id,
    OLD.action_sequence,
    OLD.semantic_action,
    OLD.signer_address,
    OLD.account_address,
    OLD.chain_id,
    OLD.nonce,
    OLD.relay_intent_id,
    OLD.request_hash,
    OLD.transaction_intent,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.job_id,
    NEW.session_id,
    NEW.task_id,
    NEW.action_sequence,
    NEW.semantic_action,
    NEW.signer_address,
    NEW.account_address,
    NEW.chain_id,
    NEW.nonce,
    NEW.relay_intent_id,
    NEW.request_hash,
    NEW.transaction_intent,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'chain action binding is immutable';
  END IF;
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
