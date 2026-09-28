-- 2C final review, Critical 1: a webhook's draft belongs to the webhook itself, so the nightly draft purge
-- must tell it apart (and delete only the draft). The worker may read which kind a draft is, nothing more.
GRANT SELECT (kind) ON imports TO lume_worker;
