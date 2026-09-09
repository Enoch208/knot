CREATE TABLE verified_quotes (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  service_request_id text NOT NULL REFERENCES service_requests(id),
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  task_id text NOT NULL REFERENCES tasks(id),
  seller_endpoint text NOT NULL CHECK (char_length(seller_endpoint) BETWEEN 1 AND 2048 AND seller_endpoint ~ '^https://'),
  provider_agent_id text NOT NULL REFERENCES agents(id),
  endpoint_observation_id text NOT NULL REFERENCES endpoint_observations(id),
  endpoint_observed_at timestamptz NOT NULL,
  seller_identity_chain_id integer NOT NULL CHECK (seller_identity_chain_id = 97),
  seller_registry text NOT NULL CHECK (seller_registry ~ '^0x[0-9a-f]{40}$'),
  seller_agent_id numeric(78, 0) NOT NULL CHECK (seller_agent_id >= 0),
  seller_owner text NOT NULL CHECK (seller_owner ~ '^0x[0-9a-f]{40}$'),
  identity_block_number numeric(78, 0) NOT NULL CHECK (identity_block_number >= 0),
  identity_block_hash text NOT NULL CHECK (identity_block_hash ~ '^0x[0-9a-f]{64}$'),
  identity_observed_at timestamptz NOT NULL,
  task_description_sha256 text NOT NULL CHECK (task_description_sha256 ~ '^0x[0-9a-f]{64}$'),
  quote_payload jsonb NOT NULL CHECK (jsonb_typeof(quote_payload) = 'object'),
  canonical_job_description text NOT NULL CHECK (octet_length(convert_to(canonical_job_description, 'UTF8')) BETWEEN 1 AND 4096),
  job_description_sha256 text NOT NULL CHECK (job_description_sha256 = '0x' || encode(sha256(convert_to(canonical_job_description, 'UTF8')), 'hex')),
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  response_hash text NOT NULL CHECK (response_hash ~ '^0x[0-9a-f]{64}$'),
  negotiation_hash text NOT NULL CHECK (negotiation_hash ~ '^0x[0-9a-f]{64}$'),
  provider_signature text NOT NULL CHECK (provider_signature ~ '^0x([0-9a-f]{2})+$'),
  signature_method text NOT NULL CHECK (signature_method IN ('eip191', 'erc1271')),
  signature_verification_basis text NOT NULL CHECK (signature_verification_basis IN ('eip191_recovered', 'erc1271_pinned_block')),
  signature_verified_block_number numeric(78, 0) CHECK (signature_verified_block_number >= 0),
  signature_verified_block_hash text CHECK (signature_verified_block_hash IS NULL OR signature_verified_block_hash ~ '^0x[0-9a-f]{64}$'),
  verifier_version text NOT NULL CHECK (verifier_version ~ '^[A-Za-z0-9._/-]{1,128}$'),
  signature_verified_at timestamptz NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 97),
  commerce text NOT NULL CHECK (commerce ~ '^0x[0-9a-f]{40}$'),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  amount_units numeric(78, 0) NOT NULL CHECK (amount_units > 0),
  token_decimals integer NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  negotiated_at numeric(78, 0) NOT NULL CHECK (negotiated_at >= 0),
  expires_at numeric(78, 0) NOT NULL CHECK (expires_at > 0),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer, service_request_id, idempotency_key),
  UNIQUE (chain_id, commerce, negotiation_hash),
  CHECK (negotiated_at < expires_at),
  CHECK (identity_observed_at <= verified_at),
  CHECK (endpoint_observed_at <= verified_at),
  CHECK (signature_verified_at <= verified_at),
  CHECK ((signature_method = 'eip191' AND signature_verification_basis = 'eip191_recovered' AND signature_verified_block_number IS NULL AND signature_verified_block_hash IS NULL AND provider_signature ~ '^0x[0-9a-f]{130}$') OR (signature_method = 'erc1271' AND signature_verification_basis = 'erc1271_pinned_block' AND signature_verified_block_number = identity_block_number AND signature_verified_block_hash = identity_block_hash)),
  CHECK (((quote_payload->>'chain_id')::integer = chain_id) IS TRUE),
  CHECK ((lower(quote_payload->>'verifying_contract') = commerce) IS TRUE),
  CHECK ((lower(quote_payload #>> '{response,terms,currency}') = token) IS TRUE),
  CHECK (((quote_payload #>> '{response,terms,price}')::numeric = amount_units) IS TRUE),
  CHECK (((quote_payload #>> '{response,negotiated_at}')::numeric = negotiated_at) IS TRUE),
  CHECK (((quote_payload #>> '{response,quote_expires_at}')::numeric = expires_at) IS TRUE),
  CHECK (((quote_payload #>> '{response,accepted}')::boolean IS TRUE)),
  CHECK ((lower(quote_payload->>'request_hash') = request_hash) IS TRUE),
  CHECK ((lower(quote_payload->>'response_hash') = response_hash) IS TRUE),
  CHECK ((lower(quote_payload->>'negotiation_hash') = negotiation_hash) IS TRUE),
  CHECK ((lower(quote_payload->>'provider_sig') = provider_signature) IS TRUE),
  CHECK ((('0x' || encode(sha256(convert_to(quote_payload #>> '{request,task_description}', 'UTF8')), 'hex')) = task_description_sha256) IS TRUE)
);

CREATE FUNCTION knot_guard_verified_quote_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
DECLARE
  bound_service_request record;
  bound_task record;
  bound_agent record;
  bound_observation record;
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

  SELECT chain_id, registry, agent_id, owner_address
  INTO bound_agent
  FROM agents
  WHERE id = NEW.provider_agent_id
  FOR UPDATE;
  IF NOT FOUND OR bound_agent.chain_id IS DISTINCT FROM NEW.seller_identity_chain_id OR bound_agent.registry IS DISTINCT FROM NEW.seller_registry OR bound_agent.agent_id IS DISTINCT FROM NEW.seller_agent_id OR bound_agent.owner_address IS DISTINCT FROM NEW.seller_owner THEN
    RAISE EXCEPTION 'verified quote agent binding is invalid';
  END IF;

  SELECT agent_id, endpoint, request_type, result, observed_at
  INTO bound_observation
  FROM endpoint_observations
  WHERE id = NEW.endpoint_observation_id
  FOR UPDATE;
  IF NOT FOUND OR bound_observation.agent_id IS DISTINCT FROM NEW.provider_agent_id OR bound_observation.endpoint IS DISTINCT FROM NEW.seller_endpoint OR bound_observation.request_type <> 'negotiate' OR bound_observation.result <> 'SUCCESS' OR bound_observation.observed_at IS DISTINCT FROM NEW.endpoint_observed_at THEN
    RAISE EXCEPTION 'verified quote endpoint observation binding is invalid';
  END IF;

  current_database_time := clock_timestamp();
  IF current_database_time >= bound_task.deadline_at OR current_database_time >= to_timestamp(NEW.expires_at::double precision) OR NEW.verified_at >= to_timestamp(NEW.expires_at::double precision) THEN
    RAISE EXCEPTION 'verified quote is expired';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER verified_quotes_insert_guard BEFORE INSERT ON verified_quotes FOR EACH ROW EXECUTE FUNCTION knot_guard_verified_quote_insert();

CREATE FUNCTION knot_reject_verified_quote_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'verified quotes are append-only';
END
$body$;

CREATE TRIGGER verified_quotes_update_guard BEFORE UPDATE OR DELETE ON verified_quotes FOR EACH ROW EXECUTE FUNCTION knot_reject_verified_quote_mutation();
CREATE TRIGGER verified_quotes_truncate_guard BEFORE TRUNCATE ON verified_quotes FOR EACH STATEMENT EXECUTE FUNCTION knot_reject_verified_quote_mutation();

CREATE FUNCTION knot_guard_verified_quote_agent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM verified_quotes WHERE provider_agent_id = OLD.id) THEN
    RAISE EXCEPTION 'agent with a verified quote binding cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM verified_quotes WHERE provider_agent_id = OLD.id) AND (OLD.id, OLD.chain_id, OLD.registry, OLD.agent_id, OLD.owner_address) IS DISTINCT FROM (NEW.id, NEW.chain_id, NEW.registry, NEW.agent_id, NEW.owner_address) THEN
    RAISE EXCEPTION 'agent identity with a verified quote binding is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER agents_verified_quote_guard BEFORE UPDATE OR DELETE ON agents FOR EACH ROW EXECUTE FUNCTION knot_guard_verified_quote_agent_mutation();

CREATE FUNCTION knot_guard_verified_quote_observation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM verified_quotes WHERE endpoint_observation_id = OLD.id) AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'endpoint observation with a verified quote binding is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER endpoint_observations_verified_quote_guard BEFORE UPDATE OR DELETE ON endpoint_observations FOR EACH ROW EXECUTE FUNCTION knot_guard_verified_quote_observation_mutation();
