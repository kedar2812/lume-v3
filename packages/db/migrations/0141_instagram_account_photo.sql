-- The connected account's own profile photo (owner 2026-11-28: "every synced account's profile photo will be shown"),
-- in Settings → Integrations → Instagram. As a lead's (0124): LUME's own copy in the file store (Meta's link is signed
-- and expires), looked at again a week after it last looked; counted by the store, gone when the account disconnects.
ALTER TABLE instagram_accounts
  ADD COLUMN photo_sha256 text REFERENCES whatsapp_files (sha256) ON DELETE RESTRICT,
  ADD COLUMN photo_mime text CHECK (photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  ADD COLUMN photo_checked_at timestamptz,
  ADD CONSTRAINT instagram_accounts_photo_check CHECK ((photo_sha256 IS NULL) = (photo_mime IS NULL));
CREATE INDEX instagram_accounts_photo ON instagram_accounts (photo_sha256) WHERE photo_sha256 IS NOT NULL;

-- The store's counts, by 0124's function (it reads only photo_sha256).
CREATE TRIGGER instagram_accounts_photo_refs_in
  AFTER INSERT ON instagram_accounts FOR EACH ROW WHEN (NEW.photo_sha256 IS NOT NULL)
  EXECUTE FUNCTION lume_instagram_photo_refs();
CREATE TRIGGER instagram_accounts_photo_refs_up
  AFTER UPDATE ON instagram_accounts FOR EACH ROW WHEN (OLD.photo_sha256 IS DISTINCT FROM NEW.photo_sha256)
  EXECUTE FUNCTION lume_instagram_photo_refs();
CREATE TRIGGER instagram_accounts_photo_refs_out
  AFTER DELETE ON instagram_accounts FOR EACH ROW WHEN (OLD.photo_sha256 IS NOT NULL)
  EXECUTE FUNCTION lume_instagram_photo_refs();

-- Disconnected however it happens (Settings, Meta's deauthorize or data deletion): the photo goes with it, and is
-- looked at afresh if the account connects again.
CREATE FUNCTION lume_instagram_account_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.photo_sha256 := NULL;
  NEW.photo_mime := NULL;
  NEW.photo_checked_at := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER instagram_accounts_gone
  BEFORE UPDATE OF status ON instagram_accounts FOR EACH ROW
  WHEN (NEW.status = 'disconnected' AND OLD.status IS DISTINCT FROM 'disconnected')
  EXECUTE FUNCTION lume_instagram_account_gone();
