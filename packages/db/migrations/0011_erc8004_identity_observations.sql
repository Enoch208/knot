CREATE TABLE erc8004_identity_observations (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  agent_record_id text NOT NULL REFERENCES agents(id),
  chain_id integer NOT NULL CHECK (chain_id = 97),
  registry text NOT NULL CHECK (registry ~ '^0x[0-9a-f]{40}$'),
  agent_id numeric(78, 0) NOT NULL CHECK (agent_id >= 0),
  owner text NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  operator_relation text NOT NULL CHECK (char_length(operator_relation) BETWEEN 1 AND 128),
  agent_wallet text CHECK (agent_wallet IS NULL OR agent_wallet ~ '^0x[0-9a-f]{40}$'),
  token_uri text NOT NULL CHECK (octet_length(convert_to(token_uri, 'UTF8')) BETWEEN 1 AND 8192),
  block_number numeric(78, 0) NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  proxy_address text NOT NULL CHECK (proxy_address = registry),
  proxy_code_hash text NOT NULL CHECK (proxy_code_hash ~ '^0x[0-9a-f]{64}$'),
  implementation_address text NOT NULL CHECK (implementation_address ~ '^0x[0-9a-f]{40}$'),
  implementation_code_hash text NOT NULL CHECK (implementation_code_hash ~ '^0x[0-9a-f]{64}$'),
  rpc_agreement jsonb NOT NULL CHECK (jsonb_typeof(rpc_agreement) = 'object'),
  observed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status = 'CONFIRMED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, registry, agent_id, block_number, observed_at),
  CHECK (observed_at <= created_at),
  CHECK (rpc_agreement ?& ARRAY['schemaVersion', 'status', 'chainId', 'blockNumber', 'blockHash', 'minimumHeadBlockNumber', 'requiredConfirmations', 'providerCount', 'agreementCount', 'providerSetHash']),
  CHECK ((rpc_agreement - ARRAY['schemaVersion', 'status', 'chainId', 'blockNumber', 'blockHash', 'minimumHeadBlockNumber', 'requiredConfirmations', 'providerCount', 'agreementCount', 'providerSetHash']) = '{}'::jsonb),
  CHECK ((rpc_agreement->>'schemaVersion') = 'knot.rpc-agreement/1'),
  CHECK ((rpc_agreement->>'status') = 'AGREED'),
  CHECK ((rpc_agreement->>'chainId') ~ '^[0-9]+$' AND (rpc_agreement->>'chainId')::integer = chain_id),
  CHECK ((rpc_agreement->>'blockNumber') ~ '^[0-9]+$' AND (rpc_agreement->>'blockNumber')::numeric = block_number),
  CHECK (lower(rpc_agreement->>'blockHash') = block_hash),
  CHECK ((rpc_agreement->>'minimumHeadBlockNumber') ~ '^[0-9]+$' AND (rpc_agreement->>'minimumHeadBlockNumber')::numeric >= block_number),
  CHECK ((rpc_agreement->>'requiredConfirmations') ~ '^[0-9]+$' AND (rpc_agreement->>'requiredConfirmations')::integer > 0),
  CHECK ((rpc_agreement->>'providerCount') ~ '^[0-9]+$' AND (rpc_agreement->>'providerCount')::integer >= 2),
  CHECK ((rpc_agreement->>'agreementCount') ~ '^[0-9]+$' AND (rpc_agreement->>'agreementCount')::integer = (rpc_agreement->>'providerCount')::integer),
  CHECK ((rpc_agreement->>'providerSetHash') ~ '^0x[0-9a-f]{64}$'),
  CHECK (confirmations >= (rpc_agreement->>'requiredConfirmations')::integer),
  CHECK (confirmations::numeric = (rpc_agreement->>'minimumHeadBlockNumber')::numeric - block_number + 1)
);

CREATE FUNCTION knot_guard_erc8004_identity_observation_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.chain_id::text || ':' || NEW.block_number::text, 0));
  IF NOT EXISTS (
    SELECT 1
    FROM agents
    WHERE id = NEW.agent_record_id
      AND chain_id = NEW.chain_id
      AND registry = NEW.registry
      AND agent_id = NEW.agent_id
      AND owner_address = NEW.owner
      AND operator_relation = NEW.operator_relation
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'ERC-8004 identity observation agent binding is invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM erc8004_identity_observations
    WHERE chain_id = NEW.chain_id
      AND block_number = NEW.block_number
      AND block_hash IS DISTINCT FROM NEW.block_hash
  ) THEN
    RAISE EXCEPTION 'ERC-8004 identity observation block contradiction';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM erc8004_identity_observations
    WHERE chain_id = NEW.chain_id
      AND registry = NEW.registry
      AND block_number = NEW.block_number
      AND (
        proxy_address,
        proxy_code_hash,
        implementation_address,
        implementation_code_hash
      ) IS DISTINCT FROM (
        NEW.proxy_address,
        NEW.proxy_code_hash,
        NEW.implementation_address,
        NEW.implementation_code_hash
      )
  ) THEN
    RAISE EXCEPTION 'ERC-8004 identity observation registry contradiction';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM erc8004_identity_observations
    WHERE chain_id = NEW.chain_id
      AND registry = NEW.registry
      AND agent_id = NEW.agent_id
      AND block_number = NEW.block_number
      AND (
        block_hash,
        owner,
        agent_wallet,
        token_uri,
        proxy_address,
        proxy_code_hash,
        implementation_address,
        implementation_code_hash
      ) IS DISTINCT FROM (
        NEW.block_hash,
        NEW.owner,
        NEW.agent_wallet,
        NEW.token_uri,
        NEW.proxy_address,
        NEW.proxy_code_hash,
        NEW.implementation_address,
        NEW.implementation_code_hash
      )
  ) THEN
    RAISE EXCEPTION 'ERC-8004 identity observation state contradiction';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER erc8004_identity_observations_insert_guard BEFORE INSERT ON erc8004_identity_observations FOR EACH ROW EXECUTE FUNCTION knot_guard_erc8004_identity_observation_insert();

CREATE FUNCTION knot_reject_erc8004_identity_observation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'ERC-8004 identity observations are append-only';
END
$body$;

CREATE TRIGGER erc8004_identity_observations_update_guard BEFORE UPDATE OR DELETE ON erc8004_identity_observations FOR EACH ROW EXECUTE FUNCTION knot_reject_erc8004_identity_observation_mutation();
CREATE TRIGGER erc8004_identity_observations_truncate_guard BEFORE TRUNCATE ON erc8004_identity_observations FOR EACH STATEMENT EXECUTE FUNCTION knot_reject_erc8004_identity_observation_mutation();
