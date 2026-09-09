CREATE OR REPLACE FUNCTION knot_valid_action_transition(current_state text, next_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $body$
  SELECT (current_state, next_state) IN (
    ('PREPARED', 'SUBMITTED'), ('PREPARED', 'FAILED'), ('PREPARED', 'UNKNOWN'),
    ('SUBMITTED', 'CONFIRMED'), ('SUBMITTED', 'FAILED'), ('SUBMITTED', 'UNKNOWN'),
    ('UNKNOWN', 'CONFIRMED'), ('UNKNOWN', 'FAILED')
  )
$body$;
