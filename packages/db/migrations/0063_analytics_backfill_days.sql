-- Owner, 2026-10-05: leads imported before 0060 (11,485 of them with their own enquiry dates, back to June 2024) were
-- never counted on their days. Every past day that has a lead's arrival, win or loss is marked once, and the analytics
-- job counts them again, newest first, a month of days a minute (rollupDirty). Today and yesterday are already covered.
INSERT INTO analytics_dirty_days (day)
SELECT DISTINCT d
FROM leads l
CROSS JOIN LATERAL lume_lead_days(l.lead_created_at, l.created_at, l.won_at, l.lost_at,
                                  coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC')) d
WHERE d < (now() AT TIME ZONE coalesce((SELECT timezone FROM settings WHERE id = 1), 'UTC'))::date - 1
ON CONFLICT (day) DO NOTHING;
