ALTER TABLE "events" ALTER COLUMN "download_policy" SET DEFAULT 'full';--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cover_crop" jsonb;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cover_preview_key" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cover_thumb_key" text;
