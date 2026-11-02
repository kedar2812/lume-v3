-- Deleting an account (owner 2026-11-02, docs/superpowers/specs/2026-11-02-delete-account-and-role.md): the person
-- forgotten (name, email, password, two-step gone), what they did kept as done by "Former member". 'deleted' is never
-- counted in places, listed in People, enabled again or offered to hand anything to.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('invited', 'active', 'disabled', 'suspended', 'deleted'));
-- An account already forgotten by hand before this existed (its email the same tombstone) is deleted, not disabled.
UPDATE users SET status = 'deleted' WHERE email LIKE 'deleted-%@deleted.lume.invalid' AND NOT is_owner;
