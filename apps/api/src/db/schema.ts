import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  real,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'editor', 'photographer']);
export const mediaType = pgEnum('media_type', ['image', 'video']);
export const collectionStatus = pgEnum('collection_status', ['draft', 'published']);
export const userStatus = pgEnum('user_status', ['active', 'suspended', 'inactive']);
export const eventStatus = pgEnum('event_status', [
  'draft',
  'active',
  'expired',
  'archived',
  'scheduled_for_deletion',
]);
export const eventVisibility = pgEnum('event_visibility', ['public', 'unlisted', 'private']);
export const downloadPolicy = pgEnum('download_policy', ['disabled', 'preview', 'full']);
export const photoStatus = pgEnum('photo_status', ['pending_upload', 'uploaded', 'processing', 'ready', 'failed']);
export const clientStatus = pgEnum('client_status', ['active', 'disabled', 'revoked']);
export const paymentModel = pgEnum('payment_model', ['free', 'owner_pays', 'attendee_pays']);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'expired',
]);

const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull().default('photographer'),
    status: userStatus('status').notNull().default('active'),
    /** Extra permissions granted by an admin on top of the role defaults. */
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    /** Permissions removed by an admin from the role defaults. */
    revokedPermissions: text('revoked_permissions').array().notNull().default(sql`'{}'::text[]`),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`), index('users_status_idx').on(t.status)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_hash_unique').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const events = pgTable(
  'events',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    eventDate: date('event_date', { mode: 'string' }),
    location: text('location'),
    status: eventStatus('status').notNull().default('draft'),
    visibility: eventVisibility('visibility').notNull().default('public'),
    accessPasswordHash: text('access_password_hash'),
    downloadPolicy: downloadPolicy('download_policy').notNull().default('preview'),
    /** Public access ends at this instant. Expiry never touches stored media. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** When an archived event becomes due for administrator deletion review. */
    retentionReviewAt: timestamp('retention_review_at', { withTimezone: true }),
    coverPhotoId: uuid('cover_photo_id'),
    paymentModel: paymentModel('payment_model').notNull().default('free'),
    paymentStatus: paymentStatus('payment_status'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('events_slug_unique').on(t.slug),
    index('events_owner_idx').on(t.ownerId),
    index('events_status_expires_idx').on(t.status, t.expiresAt),
  ],
);

/** Photographers invited to contribute to an event they do not own (the owner is typically an editor). */
export const eventMembers = pgTable(
  'event_members',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] }), index('event_members_user_idx').on(t.userId)],
);

export const galleries = pgTable(
  'galleries',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    isVisible: boolean('is_visible').notNull().default(true),
    /** null = inherit the event policy; a gallery may only restrict, never widen, the event policy. */
    downloadPolicy: downloadPolicy('download_policy'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('galleries_event_idx').on(t.eventId, t.sortOrder)],
);

export const photos = pgTable(
  'photos',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    galleryId: uuid('gallery_id').references(() => galleries.id, { onDelete: 'set null' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    mediaType: mediaType('media_type').notNull().default('image'),
    filename: text('filename').notNull(),
    /** Display name set by editors; falls back to the filename. The stored file name never changes. */
    title: text('title'),
    description: text('description').notNull().default(''),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    durationSeconds: real('duration_seconds'),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    format: text('format'),
    checksum: text('checksum'),
    status: photoStatus('status').notNull().default('pending_upload'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    originalKey: text('original_key').notNull(),
    previewKey: text('preview_key'),
    thumbKey: text('thumb_key'),
    previewSizeBytes: bigint('preview_size_bytes', { mode: 'number' }).notNull().default(0),
    thumbSizeBytes: bigint('thumb_size_bytes', { mode: 'number' }).notNull().default(0),
    isHidden: boolean('is_hidden').notNull().default(false),
    downloadPolicy: downloadPolicy('download_policy'),
    sortOrder: integer('sort_order').notNull().default(0),
    exif: jsonb('exif').$type<Record<string, unknown>>(),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('photos_event_status_idx').on(t.eventId, t.status),
    index('photos_gallery_idx').on(t.galleryId, t.sortOrder),
    index('photos_uploader_idx').on(t.uploaderId),
    index('photos_event_order_idx').on(t.eventId, t.takenAt, t.createdAt),
  ],
);

/** Curated sets of media, possibly spanning many events, exposed to company websites by slug. */
export const collections = pgTable(
  'collections',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: collectionStatus('status').notNull().default('draft'),
    coverPhotoId: uuid('cover_photo_id').references(() => photos.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('collections_slug_unique').on(t.slug)],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    photoId: uuid('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.photoId] }), index('collection_items_photo_idx').on(t.photoId), index('collection_items_order_idx').on(t.collectionId, t.sortOrder)],
);

export const collectionWebsites = pgTable(
  'collection_websites',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),

    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),

    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.collectionId, t.clientId],
    }),
    index('collection_websites_client_idx').on(t.clientId),
  ],
);

export const apiClients = pgTable(
  'api_clients',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** null = every eligible event; otherwise restricted to this allow-list. */
    allowedEventIds: uuid('allowed_event_ids').array(),
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(600),
    status: clientStatus('status').notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('api_clients_key_hash_unique').on(t.keyHash)],
);

export const apiUsageDaily = pgTable(
  'api_usage_daily',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    requests: integer('requests').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    bytesServed: bigint('bytes_served', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.day] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorType: text('actor_type').notNull(), // user | api_client | system
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    eventId: uuid('event_id'),
    targetUserId: uuid('target_user_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    meta: jsonb('meta'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action, t.createdAt),
    index('audit_event_idx').on(t.eventId),
    index('audit_actor_idx').on(t.actorId),
  ],
);

/** Raw analytics events; visitors are stored as a daily-rotating salted hash, never raw IPs. */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: id(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    photoId: uuid('photo_id'),
    type: text('type').notNull(), // event_view | photo_view | download
    source: text('source').notNull().default('web'), // web | api
    visitorHash: text('visitor_hash'),
    createdAt: createdAt(),
  },
  (t) => [index('analytics_event_type_idx').on(t.eventId, t.type, t.createdAt), index('analytics_created_idx').on(t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** null = visible to all administrators. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'), // info | warning | critical
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt), uniqueIndex('notifications_dedupe_unique').on(t.dedupeKey)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Gallery = typeof galleries.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
export type Collection = typeof collections.$inferSelect;
