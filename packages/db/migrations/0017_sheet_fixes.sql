-- 2B-1 final review. rekey_through: after an edit changes how rows are recognised (the date or contact
-- columns), rows up to this sheet row were already dealt with and are recognised again, never re-imported.
-- full_read_modified: the sheet's modifiedTime covered by the last full read, so a quiet sheet still gets
-- the hourly full read it's owed after an edit the incremental read couldn't see.
ALTER TABLE lead_sources
  ADD COLUMN rekey_through integer,
  ADD COLUMN full_read_modified text;
