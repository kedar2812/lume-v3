-- 0063 marked nothing: leads are under FORCE ROW LEVEL SECURITY (0010), so even the migration's owner role sees no
-- lead until it says whose it may read. As lume_rollup_day does, this transaction reads every lead.
SELECT set_config('lume.lead_scope', 'all', true);
INSERT INTO analytics_dirty_days (day)
SELECT DISTINCT d
FROM leads l
CROSS JOIN LATERAL lume_lead_days(l.lead_created_at, l.created_at, l.won_at, l.lost_at,
                                  coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC')) d
WHERE d < (now() AT TIME ZONE coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC'))::date - 1
ON CONFLICT (day) DO NOTHING;
SELECT set_config('lume.lead_scope', '', true);
