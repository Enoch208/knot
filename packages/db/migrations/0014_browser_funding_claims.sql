CREATE TABLE browser_funding_claims (
  verified_quote_id text PRIMARY KEY REFERENCES verified_quotes(id),
  buyer text NOT NULL CHECK (buyer ~ '^0x[0-9a-f]{40}$'),
  creation_transaction_hash text NOT NULL CHECK (creation_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  funding_transaction_hashes jsonb NOT NULL CHECK (
    jsonb_typeof(funding_transaction_hashes) = 'array'
    AND jsonb_array_length(funding_transaction_hashes) = 4
  ),
  verification_state text NOT NULL CHECK (verification_state IN ('PENDING', 'CONFIRMED', 'REVERTED', 'UNRESOLVED')),
  verification_reason text,
  chain_job_id numeric(78, 0) CHECK (chain_job_id > 0),
  confirmed_at_block numeric(78, 0) CHECK (confirmed_at_block >= 0),
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  job_snapshot jsonb,
  seller_notification_state text NOT NULL DEFAULT 'NOT_SENT' CHECK (seller_notification_state IN ('NOT_SENT', 'ACKNOWLEDGED', 'RETRYABLE_TIMEOUT', 'REJECTED')),
  seller_notification_attempted_at timestamptz,
  seller_notification_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((verification_state = 'CONFIRMED') = (chain_job_id IS NOT NULL)),
  CHECK ((seller_notification_state = 'NOT_SENT') = (seller_notification_attempted_at IS NULL)),
  UNIQUE (creation_transaction_hash),
  UNIQUE (chain_job_id),
  CHECK (NOT (funding_transaction_hashes ? creation_transaction_hash))
);

CREATE INDEX browser_funding_claims_buyer_idx
  ON browser_funding_claims (buyer, verified_quote_id);

CREATE FUNCTION knot_guard_browser_funding_claim_insert() RETURNS trigger
LANGUAGE plpgsql AS $body$
DECLARE
  bound_quote record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(NEW.funding_transaction_hashes) AS hashes(value)
    GROUP BY hashes.value HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'browser funding claim hashes must be distinct';
  END IF;
  SELECT buyer INTO bound_quote
  FROM verified_quotes
  WHERE id = NEW.verified_quote_id
  FOR KEY SHARE;
  IF NOT FOUND OR bound_quote.buyer IS DISTINCT FROM NEW.buyer THEN
    RAISE EXCEPTION 'browser funding claim buyer binding is invalid';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER browser_funding_claim_insert_guard
BEFORE INSERT ON browser_funding_claims
FOR EACH ROW EXECUTE FUNCTION knot_guard_browser_funding_claim_insert();

CREATE FUNCTION knot_guard_browser_funding_claim_update() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF (OLD.verified_quote_id, OLD.buyer, OLD.creation_transaction_hash, OLD.funding_transaction_hashes)
    IS DISTINCT FROM
    (NEW.verified_quote_id, NEW.buyer, NEW.creation_transaction_hash, NEW.funding_transaction_hashes) THEN
    RAISE EXCEPTION 'browser funding claim immutable binding cannot change';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$body$;

CREATE TRIGGER browser_funding_claim_update_guard
BEFORE UPDATE ON browser_funding_claims
FOR EACH ROW EXECUTE FUNCTION knot_guard_browser_funding_claim_update();
