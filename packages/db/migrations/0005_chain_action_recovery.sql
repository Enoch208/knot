CREATE INDEX chain_actions_recovery_queue ON chain_actions (updated_at, job_id) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
CREATE INDEX chain_actions_recovery_by_job ON chain_actions (job_id, updated_at) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
CREATE INDEX chain_actions_recovery_job ON chain_actions (job_id, action_sequence, id) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
CREATE INDEX jobs_recovery_lease ON jobs (lease_expires_at, id);
ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_transaction_hash_required CHECK (state NOT IN ('SUBMITTED', 'CONFIRMED') OR transaction_hash IS NOT NULL) NOT VALID;
ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_nonce_locator CHECK (nonce IS NOT NULL AND relay_intent_id IS NULL) NOT VALID;
CREATE VIEW chain_action_legacy_violations AS SELECT id, state, nonce, relay_intent_id, transaction_hash FROM chain_actions WHERE (state IN ('SUBMITTED', 'CONFIRMED') AND transaction_hash IS NULL) OR nonce IS NULL OR relay_intent_id IS NOT NULL;
CREATE TABLE chain_action_recovery_attempts (
  action_id text PRIMARY KEY REFERENCES chain_actions(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);
