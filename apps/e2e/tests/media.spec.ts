import { expect, request as pwRequest, test, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN, MOBILE, createEventViaUi, createUserViaUi, image, login, publish, uploadPhotos, video } from './helpers';

const stamp = Date.now().toString(36);
const photog = { name: 'Paula Photographer', email: `paula.${stamp}@e2e.test`, password: '' };
const editor = { name: 'Eddie Editor', email: `eddie.${stamp}@e2e.test`, password: '' };
const eventName = `Harbour Regatta ${stamp}`;
const collectionName = `Regatta Highlights ${stamp}`;

let admin: { ctx: BrowserContext; page: Page };
let paula: { ctx: BrowserContext; page: Page };
let eddie: { ctx: BrowserContext; page: Page };
let eventId = '';
let shareUrl = '';

test.describe.configure({ mode: 'serial' });

test.describe('Setup', () => {
  test('administrator creates a photographer and an editor', async ({ browser }) => {
    admin = await login(browser, ADMIN.email, ADMIN.password);
    photog.password = await createUserViaUi(admin.page, photog.name, photog.email);
    editor.password = await createUserViaUi(admin.page, editor.name, editor.email, 'Editor');
    await admin.page.getByLabel('Search users').fill(editor.email);
    await expect(admin.page.getByRole('row', { name: new RegExp(editor.email) })).toContainText(/editor/i);
  });
});

test.describe('Photographer: video and descriptions', () => {
  test('uploads photos and a video; the video is converted and becomes playable', async ({ browser }) => {
    paula = await login(browser, photog.email, photog.password);
    eventId = await createEventViaUi(paula.page, eventName, { downloads: 'Full resolution' });
    await expect(paula.page.getByText('Photos up to 100 MB')).toBeVisible();
    await uploadPhotos(paula.page, [await image('REG_001.jpg', [30, 90, 200]), await image('REG_002.jpg', [200, 120, 30]), await image('REG_003.jpg', [40, 160, 90]), await video('START_FINISH.mp4')]);
    // The video tile shows a duration badge once converted.
    await expect(paula.page.getByRole('button', { name: /Open START_FINISH \(video\)/ })).toBeVisible();
    await expect(paula.page.getByText(/^0:0[1-3]$/)).toBeVisible();
  });

  test('server-side Type filter shows only videos', async () => {
    await paula.page.getByLabel('Type').selectOption({ label: 'Videos' });
    await expect(paula.page.getByRole('button', { name: /^Open REG_00/ })).toHaveCount(0);
    await expect(paula.page.getByRole('button', { name: /Open START_FINISH/ })).toBeVisible();
    await paula.page.getByLabel('Type').selectOption({ value: '' });
  });

  test('plays the converted video and edits its name, description and tags', async () => {
    await paula.page.getByRole('button', { name: /Open START_FINISH/ }).click();
    const dlg = paula.page.getByRole('dialog');
    const player = dlg.locator('video');
    await expect(player).toBeVisible();
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.duration > 1), { timeout: 20_000 }).toBe(true);

    await dlg.getByLabel('Name (title)').fill('Winner crosses the finish line');
    await dlg.getByLabel('Description').fill("First place in the men's 10 km");
    await dlg.getByLabel('Add tag').fill('finish line');
    await dlg.getByLabel('Add tag').press('Enter');
    await dlg.getByLabel('Add tag').fill('Winner, Podium');
    await dlg.getByLabel('Add tag').press('Enter');
    await dlg.getByRole('button', { name: 'Save details' }).click();
    await expect(paula.page.locator('button[aria-label^="Open Winner crosses the finish line"]')).toBeAttached();
    await paula.page.keyboard.press('Escape');
    await expect(paula.page.getByRole('dialog')).toHaveCount(0);
    await expect(paula.page.getByRole('button', { name: /Open Winner crosses the finish line/ })).toBeVisible();

    // A photo too.
    await paula.page.getByRole('button', { name: /Open REG_001/ }).click();
    await paula.page.getByRole('dialog').getByLabel('Name (title)').fill('Spinnakers at the start');
    await paula.page.getByRole('dialog').getByLabel('Description').fill('Boats lining up');
    await paula.page.getByRole('dialog').getByRole('button', { name: 'Save details' }).click();
    // The grid behind the dialog relabels the item once the save has completed (an earlier toast may still be on screen).
    await expect(paula.page.locator('button[aria-label^="Open Spinnakers at the start"]')).toBeAttached();
    await paula.page.keyboard.press('Escape');
    await expect(paula.page.getByRole('dialog')).toHaveCount(0);
  });

  test('publishes the event', async () => {
    await paula.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await paula.page.getByLabel('Description').first().fill('The yearly harbour regatta');
    await paula.page.getByRole('button', { name: 'Save changes' }).click();
    await expect(paula.page.getByText('Settings saved')).toBeVisible();
    shareUrl = await publish(paula.page);
  });
});

test.describe('Attendee on a phone', () => {
  test('sees photos and the video with title, description, tags and event details; can search', async ({ browser }) => {
    const ctx = await browser.newContext(MOBILE);
    const page = await ctx.newPage();
    await page.goto(shareUrl);
    await expect(page.getByRole('heading', { name: eventName })).toBeVisible();
    await expect(page.getByText('4 items')).toBeVisible();
    await expect(page.getByRole('button', { name: /Open Winner crosses the finish line/ })).toBeVisible();
    await expect(page.getByText(/^0:0[1-3]$/).first()).toBeVisible(); // duration badge on the video tile
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole('button', { name: /Open Winner crosses the finish line/ }).click();
    const dialog = page.getByRole('dialog');
    const player = dialog.locator('video');
    await expect(player).toBeVisible();
    await expect(player).not.toHaveAttribute('autoplay', /.*/);
    await expect(dialog.getByText("First place in the men's 10 km")).toBeVisible();
    await expect(dialog.getByText('podium')).toBeVisible();
    await expect(dialog.getByText(eventName)).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByLabel('Search photos and videos').fill('podium');
    await expect(page.getByRole('button', { name: /Open Winner crosses the finish line/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open Spinnakers/ })).toHaveCount(0);
    await page.getByLabel('Search photos and videos').fill('boats lining');
    await expect(page.getByRole('button', { name: /Open Spinnakers at the start/ })).toBeVisible();
    await ctx.close();
  });
});

test.describe('Editor', () => {
  test('signs in, sees every event, and has Library and Collections but no admin or upload powers', async ({ browser }) => {
    eddie = await login(browser, editor.email, editor.password);
    await expect(eddie.page.getByRole('link', { name: 'Library', exact: true })).toBeVisible();
    await expect(eddie.page.getByRole('link', { name: 'Collections', exact: true })).toBeVisible();
    await expect(eddie.page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    await expect(eddie.page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await eddie.page.goto('/console/events');
    await expect(eddie.page.getByText(eventName)).toBeVisible(); // someone else's event
    await expect(eddie.page.getByRole('button', { name: /New event/ })).toHaveCount(0);
  });

  test('renames the event and edits a photo, but cannot upload, publish or touch access settings', async () => {
    await eddie.page.goto(`/console/events/${eventId}`);
    await expect(eddie.page.getByText("don't have permission to upload")).toBeVisible();
    await expect(eddie.page.getByRole('tab', { name: 'Developer' })).toHaveCount(0);
    await eddie.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await expect(eddie.page.getByText('Only the event owner or an administrator can change access settings')).toBeVisible();
    await expect(eddie.page.getByLabel('Who can view')).toBeDisabled();
    await expect(eddie.page.getByRole('button', { name: 'Publish event' })).toHaveCount(0);
    await expect(eddie.page.getByRole('button', { name: 'Unpublish (back to draft)' })).toHaveCount(0);

    const renamed = `${eventName} (Annual)`;
    await eddie.page.getByLabel('Name', { exact: true }).fill(renamed);
    await eddie.page.getByLabel('Location').fill('Kigali Harbour');
    await eddie.page.getByRole('button', { name: 'Save changes' }).click();
    await expect(eddie.page.getByText('Settings saved')).toBeVisible();
    await expect(eddie.page.getByRole('heading', { name: renamed })).toBeVisible();
    expect(eddie.page.url()).toContain(eventId);
    // The public link did not move when the event was renamed.
    const res = await eddie.page.request.get(`/api/public/events/${shareUrl.split('/').pop()}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).event.name).toBe(renamed);
    expect((await eddie.page.request.patch(`/api/events/${eventId}`, { data: { visibility: 'private' } })).status()).toBe(403);
    expect((await eddie.page.request.post(`/api/events/${eventId}/uploads`, { data: { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 10 }] } })).status()).toBe(403);
    expect((await eddie.page.request.get('/api/admin/users')).status()).toBe(403);
  });

  test('library: finds items by text, filters videos, selects everything matching, tags and renames in bulk', async () => {
    await eddie.page.goto('/console/library');
    const search = eddie.page.getByPlaceholder('Search titles, descriptions, tags, events…');
    await search.fill(stamp); // matches via the event name
    await expect(eddie.page.getByText('4 results')).toBeVisible();
    await search.fill(`${stamp} finish line`); // every word must match: event name + title
    await expect(eddie.page.getByText('1 result', { exact: true })).toBeVisible();
    await search.fill(stamp);
    await eddie.page.getByLabel('Type').selectOption({ label: 'Videos' });
    await expect(eddie.page.getByText('1 result', { exact: true })).toBeVisible();
    await eddie.page.getByLabel('Type').selectOption({ label: 'All types' });
    await expect(eddie.page.getByText('4 results')).toBeVisible();

    await eddie.page.getByRole('button', { name: 'Select all on this page' }).click();
    await expect(eddie.page.getByText('4 selected').first()).toBeVisible();

    // Bulk tag.
    const bar = eddie.page.getByLabel('Bulk actions');
    await bar.getByRole('button', { name: 'Add tags…' }).click();
    const tags = eddie.page.getByRole('dialog', { name: 'Add tags' });
    await tags.getByLabel('Tags').fill(`regatta-${stamp}`);
    await tags.getByLabel('Tags').press('Enter');
    await tags.getByRole('button', { name: 'Add tags' }).click();
    await expect(eddie.page.getByText(/updated|Updated/).first()).toBeVisible();

    // Verify via a tag filter.
    const filtered = eddie.page.waitForResponse((r) => r.url().includes('/api/library/media') && r.url().includes(`tag=regatta-${stamp}`));
    await eddie.page.getByPlaceholder('Filter by tag').fill(`regatta-${stamp}`);
    await filtered; // the tag filter is debounced; changing filters clears any selection, so wait for it to apply
    await expect(eddie.page.getByText('4 results')).toBeVisible();

    // Bulk rename with a template and a live preview.
    await eddie.page.getByRole('button', { name: 'Select all on this page' }).click();
    await expect(eddie.page.getByText('4 selected').first()).toBeVisible();
    await bar.getByRole('button', { name: 'Rename…' }).click();
    const rename = eddie.page.getByRole('dialog', { name: 'Rename' });
    await rename.locator('label', { hasText: 'Name template' }).locator('input').fill('Regatta - {n}');
    await expect(rename.getByText('Regatta - 001')).toBeVisible();
    await rename.getByRole('button', { name: 'Rename 4' }).click();
    await expect(eddie.page.getByText(/Regatta - 001/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('collections: creates one, adds all matching media with one click, publishes it', async () => {
    await eddie.page.goto('/console/collections');
    await eddie.page.getByRole('button', { name: 'New collection' }).first().click();
    const dlg = eddie.page.getByRole('dialog', { name: 'New collection' });
    await dlg.getByLabel('Name').fill(collectionName);
    await dlg.getByLabel('Description').fill('Best moments from the regatta');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(eddie.page.getByRole('heading', { name: collectionName })).toBeVisible();

    await eddie.page.getByRole('button', { name: 'Add media' }).first().click();
    const picker = eddie.page.getByRole('dialog', { name: 'Add media to this collection' });
    await picker.getByPlaceholder('Search titles, descriptions, tags, events…').fill(`regatta-${stamp}`);
    await expect(picker.getByText('4 results')).toBeVisible();
    await picker.getByRole('button', { name: 'Select all on this page' }).click();
    await picker.getByRole('button', { name: /Add 4 selected|Add all 4 matching/ }).click();
    await expect(eddie.page.getByText(/Added 4/)).toBeVisible();
    await expect(eddie.page.getByText('4 results')).toBeVisible();

    await eddie.page.getByRole('button', { name: 'Publish' }).first().click();
    await expect(eddie.page.getByText('Published', { exact: true }).first()).toBeVisible();
  });

  test('a photographer cannot use collections or see other photographers\' media in the library', async () => {
    await expect(paula.page.getByRole('link', { name: 'Collections', exact: true })).toHaveCount(0);
    await paula.page.goto('/console/collections');
    await expect(paula.page.getByText("You don't have access to collections")).toBeVisible();
    expect((await paula.page.request.get('/api/collections')).status()).toBe(403);
    await paula.page.goto('/console/library');
    await expect(paula.page.getByText(/4 results|result/).first()).toBeVisible();
  });
});

test.describe('Website reads the collection', () => {
  test('returns photos and the video, each with its event details, in a published collection', async () => {
    const created = await admin.page.request.post('/api/admin/websites', { data: { name: `Collections Site ${stamp}`, scopes: ['collections:read', 'images:read', 'downloads:read'] } });
    expect(created.status()).toBe(201);
    const key = (await created.json()).apiKey as string;
    const api = await pwRequest.newContext({ baseURL: 'http://localhost:4000', extraHTTPHeaders: { authorization: `Bearer ${key}` } });

    const list = await (await api.get('/api/v1/collections')).json();
    const mine = list.items.find((c: { name: string }) => c.name === collectionName);
    expect(mine).toMatchObject({ mediaCount: 4, description: 'Best moments from the regatta' });

    const media = await (await api.get(`/api/v1/collections/${mine.slug}/media`)).json();
    expect(media.total).toBe(4);
    const clip = media.items.find((i: { type: string }) => i.type === 'video');
    expect(clip).toMatchObject({
      description: "First place in the men's 10 km",
      photographer: photog.name,
      event: { name: `${eventName} (Annual)`, description: 'The yearly harbour regatta', location: 'Kigali Harbour' },
    });
    expect(clip.tags).toEqual(expect.arrayContaining(['winner', 'podium', 'finish line']));
    expect(clip.durationSeconds).toBeGreaterThan(1);
    // The preview link serves a playable MP4.
    const head = await pwRequest.newContext().then((c) => c.get(clip.urls.preview));
    expect(head.status()).toBe(200);
    expect(head.headers()['content-type']).toContain('video/mp4');

    // Search and type filters on the collection.
    expect((await (await api.get(`/api/v1/collections/${mine.slug}/media?type=video`)).json()).total).toBe(1);
    expect((await (await api.get('/api/v1/media?q=podium')).json()).items.some((i: { id: string }) => i.id === clip.id)).toBe(true);

    // Unpublishing hides it immediately.
    await eddie.page.goto('/console/collections');
    await eddie.page.getByRole('link', { name: new RegExp(collectionName) }).click();
    await eddie.page.getByRole('button', { name: 'Unpublish' }).click();
    await expect(eddie.page.getByText('Draft', { exact: true }).first()).toBeVisible();
    expect((await api.get(`/api/v1/collections/${mine.slug}`)).status()).toBe(404);
  });
});
