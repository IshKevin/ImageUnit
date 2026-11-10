ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_sub_unique" ON "users" USING btree ("oidc_sub") WHERE "users"."oidc_sub" IS NOT NULL;