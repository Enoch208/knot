ALTER TABLE verified_quotes ADD COLUMN identity_observation_id text;

ALTER TABLE verified_quotes
  ADD CONSTRAINT verified_quotes_identity_observation_fk
  FOREIGN KEY (identity_observation_id) REFERENCES erc8004_identity_observations(id)
  NOT VALID;

ALTER TABLE verified_quotes VALIDATE CONSTRAINT verified_quotes_identity_observation_fk;

ALTER TABLE verified_quotes
  ADD CONSTRAINT verified_quotes_verifier_identity_pair
  CHECK (
    (verifier_version = 'knot.owned-seller-quote/1' AND identity_observation_id IS NULL)
    OR
    (verifier_version = 'knot.owned-seller-quote/2' AND identity_observation_id IS NOT NULL)
  )
  NOT VALID;

ALTER TABLE verified_quotes VALIDATE CONSTRAINT verified_quotes_verifier_identity_pair;

CREATE INDEX verified_quotes_identity_observation_id_idx
  ON verified_quotes (identity_observation_id)
  WHERE identity_observation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION knot_guard_verified_quote_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
DECLARE
  bound_service_request record;
  bound_task record;
  bound_agent record;
  bound_endpoint_observation record;
  bound_identity_observation record;
  fee_chain_id integer;
  fee_token text;
  fee_units numeric(78, 0);
  fee_decimals integer;
  current_database_time timestamptz;
BEGIN
  SELECT buyer, task_id, endpoint, task_description_sha256
  INTO bound_service_request
  FROM service_requests
  WHERE id = NEW.service_request_id
  FOR KEY SHARE;
  IF NOT FOUND OR bound_service_request.buyer IS DISTINCT FROM NEW.buyer OR bound_service_request.task_id IS DISTINCT FROM NEW.task_id OR bound_service_request.endpoint IS DISTINCT FROM NEW.seller_endpoint OR bound_service_request.task_description_sha256 IS DISTINCT FROM NEW.task_description_sha256 THEN
    RAISE EXCEPTION 'verified quote service request binding is invalid';
  END IF;

  SELECT buyer, identity_chain_id, payment_chain_id, execution_chain_id, task_spec, deadline_at
  INTO bound_task
  FROM tasks
  WHERE id = NEW.task_id
  FOR KEY SHARE;
  IF NOT FOUND OR bound_task.buyer IS DISTINCT FROM NEW.buyer OR bound_task.identity_chain_id <> 97 OR bound_task.payment_chain_id <> 97 OR bound_task.execution_chain_id IS NOT NULL THEN
    RAISE EXCEPTION 'verified quote task boundary is invalid';
  END IF;

  fee_chain_id := (bound_task.task_spec #>> '{serviceFeeLimit,chainId}')::integer;
  fee_token := lower(bound_task.task_spec #>> '{serviceFeeLimit,token}');
  fee_units := (bound_task.task_spec #>> '{serviceFeeLimit,units}')::numeric;
  fee_decimals := (bound_task.task_spec #>> '{serviceFeeLimit,decimals}')::integer;
  IF fee_chain_id <> 97 OR fee_token IS DISTINCT FROM NEW.token OR fee_decimals IS DISTINCT FROM NEW.token_decimals OR fee_units < NEW.amount_units OR NEW.expires_at > extract(epoch FROM bound_task.deadline_at)::numeric THEN
    RAISE EXCEPTION 'verified quote payment boundary is invalid';
  END IF;

  SELECT chain_id, registry, agent_id, owner_address, operator_relation, status
  INTO bound_agent
  FROM agents
  WHERE id = NEW.provider_agent_id
  FOR UPDATE;
  IF NOT FOUND OR bound_agent.chain_id IS DISTINCT FROM NEW.seller_identity_chain_id OR bound_agent.registry IS DISTINCT FROM NEW.seller_registry OR bound_agent.agent_id IS DISTINCT FROM NEW.seller_agent_id OR bound_agent.owner_address IS DISTINCT FROM NEW.seller_owner THEN
    RAISE EXCEPTION 'verified quote agent binding is invalid';
  END IF;

  SELECT agent_id, endpoint, request_type, result, observed_at
  INTO bound_endpoint_observation
  FROM endpoint_observations
  WHERE id = NEW.endpoint_observation_id
  FOR UPDATE;
  IF NOT FOUND OR bound_endpoint_observation.agent_id IS DISTINCT FROM NEW.provider_agent_id OR bound_endpoint_observation.endpoint IS DISTINCT FROM NEW.seller_endpoint OR bound_endpoint_observation.request_type <> 'negotiate' OR bound_endpoint_observation.result <> 'SUCCESS' OR bound_endpoint_observation.observed_at IS DISTINCT FROM NEW.endpoint_observed_at THEN
    RAISE EXCEPTION 'verified quote endpoint observation binding is invalid';
  END IF;

  IF NEW.verifier_version = 'knot.owned-seller-quote/2' THEN
    SELECT agent_record_id, chain_id, registry, agent_id, owner, operator_relation, block_number, block_hash, observed_at, status
    INTO bound_identity_observation
    FROM erc8004_identity_observations
    WHERE id = NEW.identity_observation_id
    FOR KEY SHARE;
    IF NOT FOUND OR bound_agent.status <> 'HIREABLE' OR bound_identity_observation.status <> 'CONFIRMED' OR bound_identity_observation.agent_record_id IS DISTINCT FROM NEW.provider_agent_id OR bound_identity_observation.chain_id IS DISTINCT FROM NEW.seller_identity_chain_id OR bound_identity_observation.registry IS DISTINCT FROM NEW.seller_registry OR bound_identity_observation.agent_id IS DISTINCT FROM NEW.seller_agent_id OR bound_identity_observation.owner IS DISTINCT FROM NEW.seller_owner OR bound_identity_observation.operator_relation IS DISTINCT FROM bound_agent.operator_relation OR bound_identity_observation.block_number IS DISTINCT FROM NEW.identity_block_number OR bound_identity_observation.block_hash IS DISTINCT FROM NEW.identity_block_hash OR bound_identity_observation.observed_at IS DISTINCT FROM NEW.identity_observed_at OR bound_identity_observation.observed_at > NEW.verified_at THEN
      RAISE EXCEPTION 'verified quote identity observation binding is invalid';
    END IF;
  END IF;

  current_database_time := clock_timestamp();
  IF current_database_time >= bound_task.deadline_at OR current_database_time >= to_timestamp(NEW.expires_at::double precision) OR NEW.verified_at >= to_timestamp(NEW.expires_at::double precision) THEN
    RAISE EXCEPTION 'verified quote is expired';
  END IF;
  RETURN NEW;
END
$body$;

CREATE OR REPLACE FUNCTION knot_guard_verified_quote_agent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM verified_quotes WHERE provider_agent_id = OLD.id) THEN
    RAISE EXCEPTION 'agent with a verified quote binding cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM verified_quotes WHERE provider_agent_id = OLD.id) AND (OLD.id, OLD.chain_id, OLD.registry, OLD.agent_id, OLD.owner_address) IS DISTINCT FROM (NEW.id, NEW.chain_id, NEW.registry, NEW.agent_id, NEW.owner_address) THEN
    RAISE EXCEPTION 'agent identity with a verified quote binding is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.operator_relation IS DISTINCT FROM NEW.operator_relation AND EXISTS (SELECT 1 FROM verified_quotes WHERE provider_agent_id = OLD.id AND identity_observation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'agent identity with a verified quote observation binding is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$body$;
