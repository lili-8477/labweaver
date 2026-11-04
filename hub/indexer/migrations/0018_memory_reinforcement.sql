-- Reinforcement. A memory is reinforced when an agent opens it for its work and
-- when new information is merged into it. Each reinforcement gives a small rank
-- boost in rank. Nothing fades: reinforced_at only records when it last happened.
ALTER TABLE memories
  ADD COLUMN reinforced_at   TIMESTAMPTZ,
  ADD COLUMN reinforce_count INT NOT NULL DEFAULT 0;
UPDATE memories SET reinforced_at = GREATEST(created_at, COALESCE(last_hit_at, created_at));
ALTER TABLE memories
  ALTER COLUMN reinforced_at SET DEFAULT now(),
  ALTER COLUMN reinforced_at SET NOT NULL;
