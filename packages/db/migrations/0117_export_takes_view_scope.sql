-- Owner 2026-11-18: Export's scope is enforced from this release (review 2026-11-17, B2). Until now Export took out
-- every lead its holder sees, whatever its scope said, and "own" is what a ticked Export starts at. So an Export at
-- own (or unset, which reads as own) takes the widest View its holders have: its role's own, or another role held by
-- anyone who has this one (a person's permissions are all their roles together; review 2026-11-18). Nobody's exports
-- or live sheets lose rows on the update, and nobody takes out more than they see (row-level security still holds).
-- A team chosen on purpose stays; a role whose holders see only their own stays own.
WITH related AS (
  SELECT id AS role_id, id AS other FROM roles
  UNION
  SELECT mine.role_id, theirs.role_id
    FROM user_roles mine
    JOIN user_roles theirs ON theirs.user_id = mine.user_id
), widest AS (
  SELECT r.role_id, max(CASE v.scope WHEN 'all' THEN 2 WHEN 'team' THEN 1 ELSE 0 END) AS rank
    FROM related r
    JOIN role_permissions v ON v.role_id = r.other AND v.permission_key = 'leads.view'
   GROUP BY r.role_id
)
UPDATE role_permissions e
   SET scope = CASE w.rank WHEN 2 THEN 'all' ELSE 'team' END
  FROM widest w
 WHERE e.role_id = w.role_id
   AND e.permission_key = 'leads.export'
   AND coalesce(e.scope, 'own') = 'own'
   AND w.rank > 0;
