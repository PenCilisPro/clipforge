-- Project style preferences: the moment styles the AI should scout for
-- (wholesome, funny, sad, hype, ...). JSONB array of style keys — max 4 and
-- the allowed keys are enforced in the API layer (backend projects route and
-- worker clipIntel.normalizeStylePrefs).
alter table projects
  add column if not exists style_prefs jsonb not null default '[]';
