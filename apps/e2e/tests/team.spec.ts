import { expect, request as pwRequest, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN, MOBILE, createEventViaUi, createUserViaUi, image, login, video } from './helpers';

const stamp = Date.now().toString(36);
const crewA = { name: `Alice Crew ${stamp}`, email: `alice.${stamp}@e2e.test`, password: '' };
const crewB = { name: `Bob Outsider ${stamp}`, email: `bob.${stamp}@e2e.test`, password: '' };
const editor = { name: `Edna Editor ${stamp}`, email: `edna.${stamp}@e2e.test`, password: '' };
const eventName = `Coastal Run ${stamp}`;

let admin: { ctx: BrowserContext; page: Page };
let edna: { ctx: BrowserContext; page: Page };
let alice: { ctx: BrowserContext; page: Page };
let bob: { ctx: BrowserContext; page: Page };
let eventId = '';
let slug = '';

test.describe.configure({ mode: 'serial' });

test.describe('Editor creates an event and invites a photographer', () => {
  test('setup: administrator creates an editor and two photographers', async ({ browser }) => {
    admin = await login(browser, ADMIN.email, ADMIN.password);
    editor.password = await createUserViaUi(admin.page, editor.name, editor.email, 'Editor');
    crewA.password = await createUserViaUi(admin.page, crewA.name, crewA.email);
    crewB.password = await createUserViaUi(admin.page, crewB.name, crewB.email);
  });

  test('the editor creates the event and finds the photographer to invite', async ({ browser }) => {
    edna = await login(browser, editor.email, editor.password);
    eventId = await createEventViaUi(edna.page, eventName);
    await expect(edna.page.getByRole('tab', { name: 'Team' })).toBeVisible();
    await edna.page.getByRole('tab', { name: 'Team' }).click();
    await expect(edna.page.getByText('No photographers have been invited yet')).toBeVisible();

    await edna.page.getByPlaceholder('Search by name or email').fill(crewA.email);
    const row = edna.page.getByRole('listitem').filter({ hasText: crewA.email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `Invite ${crewA.name}` }).click();
    await expect(edna.page.getByText(/Invited Alice/)).toBeVisible();
    await expect(edna.page.getByRole('listitem').filter({ hasText: crewA.email }).getByRole('button', { name: `Remove ${crewA.name}` })).toBeVisible();
    // Already-invited people are no longer offered.
    await edna.page.getByPlaceholder('Search by name or email').fill(crewA.email);
    await expect(edna.page.getByText('No photographers match')).toBeVisible();
    slug = (await (await edna.page.request.get(`/api/events/${eventId}`)).json()).event.slug;
  });
});

test.describe('The invited photographer', () => {
  test('is notified, sees the event as shared, and has a contributor-only view', async ({ browser }) => {
    alice = await login(browser, crewA.email, crewA.password);
    await alice.page.getByRole('button', { name: /Notifications/ }).click();
    await expect(alice.page.getByText(new RegExp(`invited to .*${eventName}`))).toBeVisible();
    await alice.page.keyboard.press('Escape');

    await alice.page.goto('/console/events');
    const row = alice.page.getByRole('row').filter({ hasText: eventName });
    await expect(row.getByText('Shared with you')).toBeVisible();
    await row.getByRole('link', { name: eventName }).click();
    await expect(alice.page.getByText('You were invited to contribute to this event')).toBeVisible();
    await expect(alice.page.getByRole('tab', { name: 'Photographs' })).toBeVisible();
    for (const hidden of ['Settings & sharing', 'Team', 'Statistics', 'Galleries', 'Developer']) await expect(alice.page.getByRole('tab', { name: hidden })).toHaveCount(0);
  });

  test('uploads a whole folder: junk is skipped and each subfolder becomes a gallery', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'iu-folder-')), 'regatta-day');
    await mkdir(join(root, 'Start Line'), { recursive: true });
    await mkdir(join(root, 'Finish Line'), { recursive: true });
    const put = async (rel: string, f: { buffer: Buffer }) => writeFile(join(root, rel), f.buffer);
    await put('Start Line/start_01.jpg', await image('x', [30, 100, 200]));
    await put('Start Line/start_02.jpg', await image('x', [200, 100, 30]));
    await put('Finish Line/finish_01.jpg', await image('x', [40, 160, 90]));
    await put('Finish Line/finish_clip.mp4', await video('x'));
    await put('.DS_Store', { buffer: Buffer.from('junk') });
    await put('notes.txt', { buffer: Buffer.from('not media') });

    await alice.page.locator('input[webkitdirectory]').setInputFiles(root);
    await expect(alice.page.getByText(/Found 3 photos and 1 video/)).toBeVisible();
    await expect(alice.page.getByText(/Skipped 2/)).toBeVisible();
    const grouping = alice.page.getByLabel('Create a gallery for each subfolder');
    await expect(grouping).toBeChecked();
    await expect(alice.page.getByText('Start Line').first()).toBeVisible();
    await alice.page.getByRole('button', { name: 'Start upload' }).click();
    await expect(alice.page.getByText('4 ready')).toBeVisible({ timeout: 90_000 });
    await expect(alice.page.getByRole('button', { name: /Open finish_clip \(video\)/ })).toBeVisible();
  });

  test('can describe their own upload but cannot organise or change the event', async () => {
    await alice.page.getByRole('button', { name: /Open start_01/ }).click();
    const dlg = alice.page.getByRole('dialog');
    await dlg.getByLabel('Name (title)').fill('Boats at the start');
    await dlg.getByRole('button', { name: 'Save details' }).click();
    await expect(alice.page.locator('button[aria-label^="Open Boats at the start"]')).toBeAttached();
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.getByRole('dialog')).toHaveCount(0);
    await expect(alice.page.getByRole('button', { name: /^Select /i })).toHaveCount(0); // no selection / bulk tools
    const api = alice.page.request;
    expect((await api.patch(`/api/events/${eventId}`, { data: { name: 'Hijacked' } })).status()).toBe(403);
    expect((await api.post(`/api/events/${eventId}/publish`, { data: {} })).status()).toBe(403);
    expect((await api.get(`/api/events/${eventId}/members`)).status()).toBe(403);
  });
});

test.describe('Someone who was not invited', () => {
  test('cannot see or reach the event', async ({ browser }) => {
    bob = await login(browser, crewB.email, crewB.password);
    await bob.page.goto('/console/events');
    await expect(bob.page.getByText(eventName)).toHaveCount(0);
    await bob.page.goto(`/console/events/${eventId}`);
    await expect(bob.page.getByText('Event not found')).toBeVisible();
    expect((await bob.page.request.post(`/api/events/${eventId}/uploads`, { data: { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 5 }] } })).status()).toBe(404);
  });
});

test.describe('The editor curates: galleries, cover, publish', () => {
  test('sees the photographer\'s folder galleries and uploads', async () => {
    await edna.page.goto(`/console/events/${eventId}`);
    await expect(edna.page.getByRole('button', { name: /Open Boats at the start/ })).toBeVisible();
    await edna.page.getByRole('tab', { name: 'Galleries' }).click();
    for (const g of ['Start Line', 'Finish Line']) await expect(edna.page.locator(`input[value="${g}"]`)).toBeVisible();
  });

  test('chooses a cover from the photos, then uploads a dedicated cover image, then resets to automatic', async () => {
    await edna.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await expect(edna.page.getByText('Cover image').first()).toBeVisible();
    await expect(edna.page.getByRole('button', { name: 'Use automatic cover' })).toHaveCount(0); // nothing chosen yet: the first photograph is the cover

    // 1. Choose one of the event's photos.
    await edna.page.getByRole('button', { name: 'Choose from photos' }).click();
    await edna.page.getByRole('dialog').getByRole('button').filter({ has: edna.page.locator('img') }).first().click();
    await expect(edna.page.getByText('Cover image updated').first()).toBeVisible();
    const afterChoose = (await (await edna.page.request.get(`/api/events/${eventId}`)).json()).event;
    expect(afterChoose.coverPhotoId).toBeTruthy();

    // 2. Upload a dedicated banner that does not belong to the gallery.
    await edna.page.locator('input[aria-label="Choose a cover image file"]').setInputFiles(await image('BANNER_COVER.jpg', [10, 60, 120], 2400, 800));
    await expect.poll(async () => (await (await edna.page.request.get(`/api/events/${eventId}`)).json()).event.coverPhotoId, { timeout: 60_000 }).not.toBe(afterChoose.coverPhotoId);
    const banner = (await (await edna.page.request.get(`/api/events/${eventId}`)).json()).event.coverPhotoId as string;
    const hiddenList = await (await edna.page.request.get(`/api/events/${eventId}/photos?hidden=true`)).json();
    expect(hiddenList.items.some((p: { id: string }) => p.id === banner)).toBe(true); // stored as a hidden, cover-only image

    // 3. Publish (administrator) and check what attendees and websites get.
    expect((await admin.page.request.post(`/api/events/${eventId}/publish`, { data: {} })).status()).toBe(200);
    const att = await browser_newMobile(edna.ctx.browser()!);
    await att.page.goto(`/e/${slug}`);
    const hero = att.page.locator('img[fetchpriority="high"]');
    await expect(hero).toBeVisible();
    expect(await hero.getAttribute('src')).toContain(`/api/public/events/${slug}/cover`);
    expect(await hero.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    await expect(att.page.getByRole('tab', { name: 'Start Line' })).toBeVisible(); // galleries from the folder names
    await expect(att.page.getByRole('button', { name: /BANNER_COVER/ })).toHaveCount(0); // the banner is not part of the gallery
    await att.ctx.close();

    const created = await admin.page.request.post('/api/admin/websites', { data: { name: `Cover Site ${stamp}`, scopes: ['events:read', 'images:read'] } });
    const key = (await created.json()).apiKey as string;
    const site = await pwRequest.newContext({ baseURL: 'http://localhost:4000', extraHTTPHeaders: { authorization: `Bearer ${key}` } });
    const ev = (await (await site.get(`/api/v1/events/${slug}`)).json()).event;
    expect(ev.cover.thumbnail).toContain(banner);
    const thumb = await pwRequest.newContext().then((c) => c.get(ev.cover.thumbnail));
    expect(thumb.status()).toBe(200);

    // 4. Back to automatic.
    await edna.page.reload();
    await edna.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await edna.page.getByRole('button', { name: 'Use automatic cover' }).click();
    await expect(edna.page.getByText('Cover set to automatic').first()).toBeVisible();
    expect((await (await edna.page.request.get(`/api/events/${eventId}`)).json()).event.coverPhotoId).toBeNull();
  });

  test('removing the photographer ends their access at once; their uploads stay', async () => {
    await edna.page.getByRole('tab', { name: 'Team' }).click();
    await edna.page.getByRole('button', { name: `Remove ${crewA.name}` }).click();
    await edna.page.getByRole('dialog').getByRole('button', { name: /^Remove/ }).click();
    await expect(edna.page.getByText('Photographer removed').first()).toBeVisible();
    expect((await alice.page.request.get(`/api/events/${eventId}`)).status()).toBe(404);
    await alice.page.goto('/console/events');
    await expect(alice.page.getByText(eventName)).toHaveCount(0);
    expect((await (await edna.page.request.get(`/api/events/${eventId}/photos`)).json()).total).toBeGreaterThanOrEqual(4);
  });
});

async function browser_newMobile(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext(MOBILE);
  return { ctx, page: await ctx.newPage() };
}
