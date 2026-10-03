-- Phase 6B review: a file with neither an Email nor a Phone column can't be traced by its check row, so it carries
-- none; its export records no position.
ALTER TABLE lead_exports ALTER COLUMN check_position DROP NOT NULL;
