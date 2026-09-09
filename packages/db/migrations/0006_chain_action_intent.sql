ALTER TABLE chain_actions ADD COLUMN transaction_intent jsonb CHECK (transaction_intent IS NULL OR jsonb_typeof(transaction_intent) = 'object');
ALTER TABLE chain_actions ADD CONSTRAINT chain_actions_transaction_intent_required CHECK (transaction_intent IS NOT NULL) NOT VALID;
CREATE OR REPLACE VIEW chain_action_legacy_violations AS SELECT id, state, nonce, relay_intent_id, transaction_hash, transaction_intent FROM chain_actions WHERE (state IN ('SUBMITTED', 'CONFIRMED') AND transaction_hash IS NULL) OR nonce IS NULL OR relay_intent_id IS NOT NULL OR transaction_intent IS NULL;
DROP INDEX chain_actions_recovery_queue;
DROP INDEX chain_actions_recovery_by_job;
DROP INDEX chain_actions_recovery_job;
CREATE INDEX chain_actions_recovery_queue ON chain_actions (updated_at, job_id) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND transaction_intent IS NOT NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
CREATE INDEX chain_actions_recovery_by_job ON chain_actions (job_id, updated_at) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND transaction_intent IS NOT NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
CREATE INDEX chain_actions_recovery_job ON chain_actions (job_id, action_sequence, id) WHERE state IN ('PREPARED', 'SUBMITTED', 'UNKNOWN') AND nonce IS NOT NULL AND relay_intent_id IS NULL AND transaction_intent IS NOT NULL AND (state <> 'SUBMITTED' OR transaction_hash IS NOT NULL);
