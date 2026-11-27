-- A person answering, hiding or deleting a comment from a lead's Instagram tab (plan 2026-11-27-instagram-comment-actions):
-- what Instagram now shows, kept beside the comment. Instagram can't edit a comment's words; hiding is its only update.
ALTER TABLE instagram_comments
  ADD COLUMN hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN public_reply text,
  ADD COLUMN public_reply_id text,
  -- Instagram's answer never came: it may be there. Never sent again by itself; the tab says to check Instagram.
  ADD COLUMN public_reply_unsure boolean NOT NULL DEFAULT false;
