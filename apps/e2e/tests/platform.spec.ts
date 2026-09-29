import { expect, request as pwRequest, test, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN, MOBILE, createEventViaUi, createUserViaUi, image, login, publish, signIn, uploadPhotos } from './helpers';

const stamp = Date.now().toString(36);
const anna = { name: 'Anna Photographer', email: `anna.${stamp}@e2e.test`, password: '' };
const ben = { name: 'Ben Photographer', email: `ben.${stamp}@e2e.test`, password: '' };
const eventName = `Kigali Marathon ${stamp}`;
const privateName = `Private Gala ${stamp}`;

let admin: { ctx: BrowserContext; page: Page };
let annaS: { ctx: BrowserContext; page: Page };
let eventId = '';
let shareUrl = '';
let apiKey = '';

test.describe.configure({ mode: 'serial' });

test.describe('Administrator', () => {
  test('signs in and sees the platform overview', async ({ browser }) => {
    admin = await login(browser, ADMIN.email, ADMIN.password);
    await expect(admin.page.getByText('Platform overview')).toBeVisible();
    for (const label of ['Photographers', 'Events', 'Photographs', 'Storage used', 'Downloads']) await expect(admin.page.getByText(label, { exact: true }).first()).toBeVisible();
    for (const link of ['Users', 'Websites', 'Storage', 'Audit log', 'System health', 'Settings']) await expect(admin.page.getByRole('link', { name: link, exact: true })).toBeVisible();
  });

  test('creates photographers and finds them with search and filters', async () => {
    anna.password = await createUserViaUi(admin.page, anna.name, anna.email);
    ben.password = await createUserViaUi(admin.page, ben.name, ben.email);
    await admin.page.getByLabel('Search users').fill(anna.email);
    await expect(admin.page.getByRole('row', { name: new RegExp(anna.email) })).toBeVisible();
    await expect(admin.page.getByRole('row', { name: new RegExp(ben.email) })).toHaveCount(0);
    await admin.page.getByLabel('Search users').fill('');
    await admin.page.getByLabel('Filter by role').selectOption({ label: 'Administrator' });
    await expect(admin.page.getByRole('row', { name: new RegExp(anna.email) })).toHaveCount(0);
  });

  test('rejects duplicate emails', async () => {
    await admin.page.goto('/console/admin/users');
    await admin.page.getByRole('button', { name: /New user/ }).click();
    const dlg = admin.page.getByRole('dialog', { name: 'New user' });
    await dlg.getByLabel('Full name').fill('Dup');
    await dlg.getByLabel('Email').fill(anna.email);
    await dlg.getByRole('button', { name: 'Create user' }).click();
    await expect(dlg.getByRole('alert').filter({ hasText: /already exists/i })).toBeVisible();
  });
});

test.describe('Photographer', () => {
  test('signs in with the temporary password', async ({ browser }) => {
    annaS = await login(browser, anna.email, anna.password);
    await expect(annaS.page.getByText('Your events and photographs')).toBeVisible();
    // Photographer navigation has no administration section.
    await expect(annaS.page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    await expect(annaS.page.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  });

  test('creates an event, bulk-uploads photos and watches them become ready', async () => {
    eventId = await createEventViaUi(annaS.page, eventName, { downloads: 'Full resolution' });
    await expect(annaS.page.getByText('Draft')).toBeVisible();
    const files = await Promise.all([image('IMG_001.jpg', [220, 60, 60]), image('IMG_002.jpg', [60, 200, 90]), image('IMG_003.jpg', [70, 90, 220], 1000, 1500), image('IMG_004.jpg', [230, 200, 40])]);
    await uploadPhotos(annaS.page, files);
    await expect(annaS.page.getByRole('img', { name: 'IMG_003.jpg' })).toBeVisible();
  });

  test('rejects unsupported files per file without blocking the batch', async () => {
    await annaS.page.locator('input[type=file]').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }, await image('IMG_005.jpg', [10, 10, 10])]);
    await expect(annaS.page.getByText('Unsupported type text/plain')).toBeVisible();
    await expect(annaS.page.getByText('5 ready')).toBeVisible({ timeout: 60_000 });
  });

  test('cannot publish an empty event', async () => {
    const empty = await createEventViaUi(annaS.page, `Empty ${stamp}`);
    await annaS.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await annaS.page.getByRole('button', { name: 'Publish event' }).click();
    await expect(annaS.page.getByRole('alert').filter({ hasText: /at least one photograph/i })).toBeVisible();
    expect(empty).not.toBe(eventId);
  });

  test('organises galleries: add, rename, hide, move photos, set cover', async () => {
    await annaS.page.goto(`/console/events/${eventId}`);
    await annaS.page.getByRole('tab', { name: 'Galleries' }).click();
    await annaS.page.getByLabel('New gallery name').fill('Finish Line');
    await annaS.page.getByRole('button', { name: 'Add gallery' }).click();
    await expect(annaS.page.getByLabel('Gallery name')).toHaveCount(2);

    await annaS.page.getByRole('tab', { name: 'Photographs' }).click();
    await annaS.page.getByRole('button', { name: 'Select IMG_001.jpg' }).click();
    await annaS.page.getByRole('button', { name: 'Select IMG_002.jpg' }).click();
    await expect(annaS.page.getByText('2 selected')).toBeVisible();
    await annaS.page.getByLabel('Move to gallery').selectOption({ label: 'Finish Line' });
    await annaS.page.getByLabel('Gallery', { exact: true }).selectOption({ label: 'Finish Line (2)' });
    await expect(annaS.page.getByRole('img', { name: 'IMG_001.jpg' })).toBeVisible();
    await expect(annaS.page.getByRole('img', { name: 'IMG_003.jpg' })).toHaveCount(0);
    await annaS.page.getByLabel('Gallery', { exact: true }).selectOption({ label: 'All galleries' });

    // Hide one photo from the public.
    await annaS.page.getByRole('button', { name: 'Select IMG_005.jpg' }).click();
    await annaS.page.getByRole('button', { name: 'Hide' }).click();
    await expect(annaS.page.getByLabel('Hidden')).toHaveCount(1);

    await annaS.page.getByRole('button', { name: 'Open IMG_004.jpg' }).click();
    await annaS.page.getByRole('button', { name: 'Set as cover' }).click();
    await expect(annaS.page.getByText('Cover photo updated')).toBeVisible();
    await annaS.page.keyboard.press('Escape');
  });

  test('publishes, gets a link and QR code, sees statistics', async () => {
    shareUrl = await publish(annaS.page);
    expect(shareUrl).toContain('/e/');
    const qr = annaS.page.getByRole('img', { name: /QR code linking to/ });
    await expect(qr).toBeVisible();
    const res = await annaS.page.request.get(`/api/events/${eventId}/qr?format=png`);
    expect(res.headers()['content-type']).toContain('image/png');
    await annaS.page.getByRole('tab', { name: 'Statistics' }).click();
    await expect(annaS.page.getByText('Gallery views', { exact: true })).toBeVisible();
  });

  test('edits settings: description, downloads, unlisted', async () => {
    await annaS.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await annaS.page.getByLabel('Description').fill('Annual city marathon');
    await annaS.page.getByLabel('Downloads').selectOption({ label: 'Preview quality' });
    await annaS.page.getByRole('button', { name: 'Save changes' }).click();
    await expect(annaS.page.getByText('Settings saved')).toBeVisible();
  });
});

test.describe('Attendee (mobile, no account)', () => {
  test('opens the link, browses, views and downloads a photo', async ({ browser }) => {
    const ctx = await browser.newContext(MOBILE);
    const page = await ctx.newPage();
    await page.goto(shareUrl);
    await expect(page.getByRole('heading', { name: eventName })).toBeVisible();
    await expect(page.getByText('Annual city marathon')).toBeVisible();
    await expect(page.getByText('4 photos')).toBeVisible(); // 5 uploaded, 1 hidden
    await expect(page.getByRole('img', { name: 'IMG_005.jpg' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Finish Line' })).toBeVisible();
    // No horizontal overflow on mobile.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole('tab', { name: 'Finish Line' }).click();
    await expect(page.getByRole('img', { name: /IMG_00[12]\.jpg/ })).toHaveCount(2);
    await page.getByRole('tab', { name: 'All' }).click();
    await page.getByLabel('Search photos').fill('IMG_003');
    await expect(page.getByRole('img', { name: 'IMG_003.jpg' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'IMG_004.jpg' })).toHaveCount(0);
    await page.getByLabel('Search photos').fill('');

    await page.getByRole('button', { name: 'Open IMG_004.jpg' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: /Download/ }).click()]);
    expect(download.suggestedFilename()).toBe('IMG_004.jpg');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await ctx.close();
  });

  test('desktop lightbox navigates with the keyboard', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(shareUrl);
    await page.getByRole('button', { name: /^Open / }).first().click();
    await expect(page.getByText(/^1 \/ /)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/^2 \/ /)).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByText(/^1 \/ /)).toBeVisible();
    await ctx.close();
  });

  test('cannot reach admin or console areas', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/console/admin/users');
    await expect(page).toHaveURL(/\/login/);
    const api = ctx.request;
    for (const url of ['/api/admin/users', '/api/events', '/api/admin/audit', '/api/admin/stats']) expect((await api.get(url)).status()).toBe(401);
    expect((await api.get(`/api/events/${eventId}/photos`)).status()).toBe(401);
    expect((await page.request.get('/api/public/events/does-not-exist')).status()).toBe(404);
    await ctx.close();
  });

  test('private gallery: password required, wrong rejected, correct unlocks', async ({ browser }) => {
    await createEventViaUi(annaS.page, privateName, { visibility: 'Password protected', password: 'open-sesame' });
    await uploadPhotos(annaS.page, [await image('SECRET_1.jpg', [120, 120, 120])]);
    const url = await publish(annaS.page);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await expect(page.getByText('This gallery is password protected.')).toBeVisible();
    await expect(page.getByRole('img', { name: 'SECRET_1.jpg' })).toHaveCount(0);
    await page.getByLabel('Gallery password').fill('wrong-pass');
    await page.getByRole('button', { name: 'View photos' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /incorrect/i })).toBeVisible();
    await page.getByLabel('Gallery password').fill('open-sesame');
    await page.getByRole('button', { name: 'View photos' }).click();
    await expect(page.getByRole('img', { name: 'SECRET_1.jpg' })).toBeVisible();
    await ctx.close();
  });
});

test.describe('Website / external system', () => {
  test('admin registers a website; it retrieves events, galleries and photos', async () => {
    await admin.page.goto('/console/admin/websites');
    await admin.page.getByRole('button', { name: /New website/ }).click();
    const dlg = admin.page.getByRole('dialog', { name: 'New website' });
    await dlg.getByLabel('Name').fill(`Company Events Site ${stamp}`);
    await dlg.getByRole('button', { name: 'Create website' }).click();
    apiKey = (await admin.page.getByLabel('Secret value').textContent())!.trim();
    expect(apiKey).toMatch(/^iu_live_/);
    await admin.page.getByRole('button', { name: 'I have saved it' }).click();

    const api = await pwRequest.newContext({ baseURL: 'http://localhost:4000', extraHTTPHeaders: { authorization: `Bearer ${apiKey}` } });
    const events = await (await api.get('/api/v1/events?pageSize=200')).json();
    const mine = events.items.find((e: { name: string }) => e.name === eventName);
    expect(mine).toBeTruthy();
    expect(events.items.some((e: { name: string }) => e.name === privateName)).toBe(false); // private never exposed
    const galleries = await (await api.get(`/api/v1/events/${mine.id}/galleries`)).json();
    expect(galleries.items.map((g: { name: string }) => g.name)).toContain('Finish Line');
    const photos = await (await api.get(`/api/v1/events/${mine.id}/photos`)).json();
    expect(photos.total).toBe(4);
    expect(photos.items[0].urls.download).toBeNull(); // downloads scope not granted
    const thumb = await pwRequest.newContext().then((c) => c.get(photos.items[0].urls.thumbnail));
    expect(thumb.status()).toBe(200);
    expect(thumb.headers()['content-type']).toContain('image/');
    expect((await pwRequest.newContext().then((c) => c.get('http://localhost:4000/api/v1/events'))).status()).toBe(401);
  });

  test('disable, re-enable, rotate and revoke take effect immediately', async () => {
    const api = await pwRequest.newContext({ baseURL: 'http://localhost:4000' });
    const status = async (key = apiKey) => (await api.get('/api/v1/events', { headers: { authorization: `Bearer ${key}` } })).status();
    const row = admin.page.getByRole('row', { name: new RegExp(`Company Events Site ${stamp}`) });
    await admin.page.reload();
    await row.getByRole('button', { name: 'Disable' }).click();
    await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();
    expect(await status()).toBe(403);
    await row.getByRole('button', { name: 'Enable' }).click();
    await expect(row.getByRole('button', { name: 'Disable' })).toBeVisible();
    expect(await status()).toBe(200);

    await row.getByRole('button', { name: 'Rotate key' }).click();
    await admin.page.getByRole('dialog', { name: 'Rotate API key' }).getByRole('button', { name: 'Rotate key' }).click();
    const newKey = (await admin.page.getByLabel('Secret value').textContent())!.trim();
    await admin.page.getByRole('button', { name: 'I have saved it' }).click();
    expect(await status(apiKey)).toBe(401);
    expect(await status(newKey)).toBe(200);
    apiKey = newKey;

    await row.getByRole('button', { name: 'Revoke' }).click();
    await admin.page.getByRole('dialog', { name: 'Revoke access' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(row.getByText('Revoked')).toBeVisible();
    expect(await status()).toBe(403);
  });
});

test.describe('Security boundaries', () => {
  test('photographer sees the admin gate and gets 403 from admin APIs', async () => {
    await annaS.page.goto('/console/admin/users');
    await expect(annaS.page.getByText('Administrators only')).toBeVisible();
    for (const url of ['/api/admin/users', '/api/admin/audit', '/api/admin/websites', '/api/admin/stats', '/api/admin/storage']) expect((await annaS.page.request.get(url)).status()).toBe(403);
  });

  test("another photographer cannot see or touch Anna's event", async ({ browser }) => {
    const b = await login(browser, ben.email, ben.password);
    await b.page.goto(`/console/events/${eventId}`);
    await expect(b.page.getByText('Event not found')).toBeVisible();
    expect((await b.page.request.get(`/api/events/${eventId}`)).status()).toBe(404);
    expect((await b.page.request.patch(`/api/events/${eventId}`, { data: { name: 'hijack' } })).status()).toBe(404);
    expect((await b.page.request.post(`/api/events/${eventId}/uploads`, { data: { files: [{ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 5 }] } })).status()).toBe(404);
    await b.page.goto('/console/events');
    await expect(b.page.getByText(eventName)).toHaveCount(0);
    await b.ctx.close();
  });

  test('photographers cannot permanently delete photographs, archive or delete events', async () => {
    const photos = await (await annaS.page.request.get(`/api/events/${eventId}/photos`)).json();
    const id = photos.items[0].id;
    expect((await annaS.page.request.delete(`/api/photos/${id}`)).status()).toBe(403);
    expect((await annaS.page.request.post(`/api/events/${eventId}/photos/delete`, { data: { photoIds: [id] } })).status()).toBe(403);
    expect((await annaS.page.request.post(`/api/events/${eventId}/archive`, { data: {} })).status()).toBe(403);
    expect((await annaS.page.request.delete(`/api/events/${eventId}?confirm=x`)).status()).toBe(403);
    await annaS.page.goto(`/console/events/${eventId}`);
    await expect(annaS.page.getByRole('button', { name: 'Select IMG_001.jpg' })).toBeVisible();
    await annaS.page.getByRole('button', { name: 'Select IMG_001.jpg' }).click();
    await expect(annaS.page.getByRole('button', { name: /Delete/ })).toHaveCount(0); // no delete affordance either
    await annaS.page.getByRole('button', { name: 'Clear' }).click();
  });

  test('cross-origin state-changing requests are refused', async () => {
    const res = await annaS.page.request.post('/api/events', { data: { name: 'evil event' }, headers: { origin: 'https://evil.example' } });
    expect(res.status()).toBe(403);
  });

  test('suspending a photographer ends their session immediately; reactivating restores access', async ({ browser }) => {
    await admin.page.goto('/console/admin/users');
    await admin.page.getByLabel('Filter by role').selectOption({ label: 'All roles' });
    await admin.page.getByLabel('Search users').fill(anna.email);
    await admin.page.getByRole('row', { name: new RegExp(anna.email) }).click();
    await admin.page.getByRole('button', { name: 'Suspend', exact: true }).click();
    await admin.page.getByRole('dialog', { name: 'Suspend user' }).getByRole('button', { name: 'Suspend' }).click();
    await expect(admin.page.getByText('Suspended').first()).toBeVisible();

    expect((await annaS.page.request.get('/api/events')).status()).toBe(401);
    await annaS.page.goto('/console/events');
    await expect(annaS.page).toHaveURL(/\/login/);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, anna.email, anna.password);
    await expect(page.getByRole('alert').filter({ hasText: /suspended/i })).toBeVisible();
    await ctx.close();

    await admin.page.getByRole('button', { name: 'Activate', exact: true }).click();
    await admin.page.getByRole('dialog', { name: 'Activate user' }).getByRole('button', { name: 'Activate', exact: true }).click();
    await expect(admin.page.getByRole('button', { name: 'Suspend' })).toBeVisible();
    annaS = await login(browser, anna.email, anna.password);
  });

  test('photographer permissions can be revoked by an admin', async () => {
    await admin.page.getByRole('checkbox', { name: /Create events/ }).uncheck();
    await admin.page.getByRole('button', { name: 'Save permissions' }).click();
    await expect(admin.page.getByText(/saved|updated/i).first()).toBeVisible();
    expect((await annaS.page.request.post('/api/events', { data: { name: 'Should fail' } })).status()).toBe(403);
    await admin.page.getByRole('checkbox', { name: /Create events/ }).check();
    await admin.page.getByRole('button', { name: 'Save permissions' }).click();
    await expect(async () => expect((await annaS.page.request.post('/api/events', { data: { name: `Allowed ${stamp}` } })).status()).toBe(201)).toPass();
  });
});

test.describe('Administrator: oversight, lifecycle and deletion', () => {
  test('sees every event, all photographs, and can open any event', async () => {
    await admin.page.goto('/console/events');
    await expect(admin.page.getByText(eventName)).toBeVisible();
    await expect(admin.page.getByText(anna.name).first()).toBeVisible();
    await admin.page.getByRole('link', { name: eventName }).click();
    await expect(admin.page.getByRole('heading', { name: eventName })).toBeVisible();
    await expect(admin.page.getByRole('img', { name: 'IMG_003.jpg' })).toBeVisible();
  });

  test('Developer tab: admin sees API details and previews exactly what a website receives; photographers do not', async () => {
    const created = await admin.page.request.post('/api/admin/websites', { data: { name: `Dev Preview Site ${stamp}` } });
    expect(created.status()).toBe(201);

    // Photographers (even the owner) get no Developer tab and no API access to it.
    await annaS.page.goto(`/console/events/${eventId}`);
    await expect(annaS.page.getByRole('tab', { name: 'Photographs' })).toBeVisible();
    await expect(annaS.page.getByRole('tab', { name: 'Developer' })).toHaveCount(0);
    expect((await annaS.page.request.get(`/api/admin/events/${eventId}/developer`)).status()).toBe(403);

    await admin.page.goto(`/console/events/${eventId}`);
    await admin.page.getByRole('tab', { name: 'Developer' }).click();
    await expect(admin.page.getByText('Available to websites')).toBeVisible();
    await expect(admin.page.getByText(`/api/v1/events/${eventId}/photos`).first()).toBeVisible();
    await admin.page.getByRole('tab', { name: 'JavaScript' }).click();
    await expect(admin.page.getByLabel('Code example')).toContainText('Authorization: `Bearer ${process.env.IU_KEY}`');
    await admin.page.getByRole('tab', { name: 'Python' }).click();
    await expect(admin.page.getByLabel('Code example')).toContainText('requests.get');

    await admin.page.getByLabel('Website').selectOption({ label: `Dev Preview Site ${stamp}` });
    await admin.page.getByLabel('Resource').selectOption({ label: 'Photos' });
    await admin.page.getByRole('button', { name: 'Run request' }).click();
    await expect(admin.page.getByLabel('Response body')).toContainText('"thumbnail"');
    await expect(admin.page.getByLabel('Response body')).toContainText('"total": 4');
    await expect(admin.page.getByRole('img', { name: /IMG_00\d\.jpg/ }).first()).toBeVisible();
    // The signed thumbnails in the preview really load.
    expect(await admin.page.getByRole('img', { name: /IMG_00\d\.jpg/ }).first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  });

  test('extends access and the expiry closes the public gallery, then reactivates', async ({ browser }) => {
    const past = await admin.page.request.patch(`/api/events/${eventId}`, { data: { expiresAt: new Date(Date.now() - 60_000).toISOString() } });
    expect(past.status()).toBe(200);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(shareUrl);
    await expect(page.getByText('This gallery has expired')).toBeVisible();
    // Photos still exist for the owner.
    const photos = await (await admin.page.request.get(`/api/events/${eventId}/photos`)).json();
    expect(photos.total).toBe(5);

    await admin.page.reload();
    await admin.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await admin.page.getByRole('button', { name: 'Extend access' }).click();
    await admin.page.getByRole('dialog', { name: 'Extend access' }).getByRole('button', { name: 'Extend' }).click();
    await expect(admin.page.getByText('Event extended')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: eventName })).toBeVisible();
    await ctx.close();
  });

  test('deletes photographs permanently through the UI', async () => {
    await admin.page.getByRole('tab', { name: 'Photographs' }).click();
    await admin.page.getByRole('button', { name: 'Select IMG_005.jpg' }).click();
    await admin.page.getByRole('button', { name: /Delete/ }).click();
    await admin.page.getByRole('dialog', { name: 'Permanently delete photographs?' }).getByRole('button', { name: 'Delete permanently' }).click();
    await expect(admin.page.getByText('Photographs permanently deleted')).toBeVisible();
    await expect(admin.page.getByRole('img', { name: 'IMG_005.jpg' })).toHaveCount(0);
  });

  test('archives the event (public link stops), then permanently deletes it', async ({ browser }) => {
    await admin.page.getByRole('tab', { name: 'Settings & sharing' }).click();
    await admin.page.getByRole('button', { name: 'Archive', exact: true }).click();
    await admin.page.getByRole('dialog', { name: 'Archive event?' }).getByRole('button', { name: 'Archive' }).click();
    await expect(admin.page.getByText('Status: Archived')).toBeVisible();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto(shareUrl);
    expect(res?.status()).toBe(404);
    await ctx.close();

    await admin.page.getByRole('button', { name: /Delete permanently/ }).click();
    const dlg = admin.page.getByRole('dialog', { name: 'Permanently delete event?' });
    const slug = shareUrl.split('/').pop()!;
    await dlg.getByLabel('Confirm event link').fill('wrong');
    await dlg.getByRole('button', { name: 'Delete forever' }).click();
    await expect(admin.page.getByText(/does not match/i)).toBeVisible();
    await dlg.getByLabel('Confirm event link').fill(slug);
    await dlg.getByRole('button', { name: 'Delete forever' }).click();
    await expect(admin.page).toHaveURL(/\/console\/events$/);
    await expect(admin.page.getByRole('link', { name: eventName })).toHaveCount(0);
  });

  test('audit log recorded the sensitive actions', async () => {
    await admin.page.goto('/console/admin/audit');
    for (const action of ['photo.deleted', 'event.archived', 'event.deleted', 'user.suspended', 'user.permissions_changed', 'api_client.revoked', 'api_client.key_rotated', 'event.published']) {
      await admin.page.getByLabel(/action/i).first().fill(action);
      await expect(admin.page.getByText(action).first(), action).toBeVisible();
    }
    // Append-only: no edit/delete affordances, and the API offers none.
    expect((await admin.page.request.delete('/api/admin/audit')).status()).toBe(404);
  });

  test('storage, health, settings and notifications pages work', async () => {
    await admin.page.goto('/console/admin/storage');
    await expect(admin.page.getByText(/Available/).first()).toBeVisible();
    await expect(admin.page.getByText(anna.name).first()).toBeVisible();

    await admin.page.goto('/console/admin/health');
    await expect(admin.page.getByText(/database/i).first()).toBeVisible();
    const health = await (await admin.page.request.get('/api/admin/health')).json();
    expect(health.checks).toEqual({ database: true, storage: true, redis: true });

    await admin.page.goto('/console/admin/settings');
    await admin.page.getByLabel(/access days|Default access/i).first().fill('45');
    await admin.page.getByRole('button', { name: 'Save settings' }).click();
    await expect(admin.page.getByText(/saved|updated/i).first()).toBeVisible();
    const s = await (await admin.page.request.get('/api/admin/settings')).json();
    expect(s.settings.defaultAccessDays).toBe(45);
    await admin.page.getByLabel(/access days|Default access/i).first().fill('30');
    await admin.page.getByRole('button', { name: 'Save settings' }).click();

    await admin.page.goto('/console');
    await admin.page.getByRole('button', { name: /Notifications/ }).click();
    await expect(admin.page.getByText(/Processing finished|caught up/).first()).toBeVisible();
  });

  test('user detail: reset password forces re-login with the new password', async ({ browser }) => {
    await admin.page.goto('/console/admin/users');
    await admin.page.getByLabel('Search users').fill(ben.email);
    await admin.page.getByRole('row', { name: new RegExp(ben.email) }).click();
    await admin.page.getByRole('button', { name: 'Reset password' }).first().click();
    await admin.page.getByRole('dialog', { name: 'Reset password' }).getByRole('button', { name: 'Reset password' }).click();
    const fresh = (await admin.page.getByLabel('Secret value').textContent())!.trim();
    await admin.page.getByRole('button', { name: 'I have saved it' }).click();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, ben.email, ben.password);
    await expect(page.getByRole('alert').filter({ hasText: /invalid/i })).toBeVisible();
    await signIn(page, ben.email, fresh);
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await ctx.close();
  });

  test('sign out ends the session', async () => {
    await admin.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(admin.page).toHaveURL(/\/login/);
    expect((await admin.page.request.get('/api/admin/stats')).status()).toBe(401);
  });
});
