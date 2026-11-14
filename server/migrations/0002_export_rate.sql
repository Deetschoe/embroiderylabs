-- Export starts per account per minute (see RATE in src/plans.js): find a user's recent rows quickly.
-- export_log.status is now 'ok' | 'failed' | 'attempt' | 'refused'; only 'ok' rows count against a plan.
CREATE INDEX IF NOT EXISTS export_log_user_time ON export_log(user_id, created_at);
