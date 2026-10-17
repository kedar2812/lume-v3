-- Control each client (spec 2026-10-17 control §2.2): the modules the plan last left out, so a module is switched off
-- (and admins told) once per change, not at every check-in.
ALTER TABLE licence_state ADD COLUMN plan_applied jsonb;
