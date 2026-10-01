-- Fast library search across tens of thousands of media items.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Substring search over title + file name + description (ILIKE '%term%' uses this index when the expression matches).
CREATE INDEX photos_search_trgm_idx ON photos USING gin ((lower(coalesce(title, '') || ' ' || filename || ' ' || coalesce(description, ''))) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX photos_tags_idx ON photos USING gin (tags);
--> statement-breakpoint
CREATE INDEX photos_media_type_idx ON photos (media_type, created_at DESC);
--> statement-breakpoint
CREATE INDEX events_name_trgm_idx ON events USING gin (lower(name) gin_trgm_ops);
