-- Enquiries from lumecrm.in (website spec §7): who asked for a demo, and where the owner has got to with them.
CREATE TABLE enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  business text NOT NULL CHECK (length(btrim(business)) BETWEEN 1 AND 160),
  whatsapp text NOT NULL CHECK (whatsapp ~ '^\+[1-9][0-9]{6,14}$'),
  email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  team_size text NOT NULL CHECK (team_size IN ('1', '2-5', '6-20', '21+')),
  how text CHECK (how IS NULL OR length(how) <= 500),
  source text NOT NULL DEFAULT 'website' CHECK (source IN ('website')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'demo_booked', 'won', 'not_a_fit')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiries_new ON enquiries (created_at DESC);
CREATE INDEX enquiries_whatsapp_recent ON enquiries (whatsapp, created_at DESC);
