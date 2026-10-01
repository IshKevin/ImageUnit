import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

export const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com', password: process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe!12345' };
export const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } as const;

export async function image(name: string, color: [number, number, number], w = 1600, h = 1000) {
  const buffer = await sharp({ create: { width: w, height: h, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).jpeg().toBuffer();
  return { name, mimeType: 'image/jpeg', buffer };
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function login(browser: Browser, email: string, password: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, password);
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  return { ctx, page };
}

/** Admin UI: create a user and return the one-time temporary password. */
export async function createUserViaUi(page: Page, name: string, email: string, role: 'Photographer' | 'Editor' | 'Administrator' = 'Photographer') {
  await page.goto('/console/admin/users');
  await page.getByRole('button', { name: /New user/ }).click();
  const dlg = page.getByRole('dialog', { name: 'New user' });
  await dlg.getByLabel('Full name').fill(name);
  await dlg.getByLabel('Email').fill(email);
  if (role !== 'Photographer') await dlg.getByLabel('Role').selectOption({ value: role.toLowerCase() });
  await dlg.getByRole('button', { name: 'Create user' }).click();
  const secret = page.getByLabel('Secret value');
  await expect(secret).toBeVisible();
  const password = (await secret.textContent())!.trim();
  await page.getByRole('button', { name: 'I have saved it' }).click();
  return password;
}

export async function createEventViaUi(page: Page, name: string, opts: { visibility?: 'Public' | 'Password protected'; password?: string; downloads?: 'Disabled' | 'Preview quality' | 'Full resolution' } = {}) {
  await page.goto('/console/events');
  await page.getByRole('button', { name: /New event/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Event name').fill(name);
  await dlg.getByLabel('Location').fill('Kigali');
  if (opts.visibility) await dlg.getByLabel('Who can view').selectOption({ label: opts.visibility });
  if (opts.password) await dlg.getByLabel('Gallery password').fill(opts.password);
  if (opts.downloads) await dlg.getByLabel('Downloads').selectOption({ label: opts.downloads });
  await dlg.getByRole('button', { name: 'Create event' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return page.url().split('/').pop()!;
}

export async function uploadPhotos(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByText(new RegExp(`Completed ${files.length}`))).toBeVisible();
  await expect(page.getByText(`${files.length} ready`)).toBeVisible({ timeout: 60_000 });
}

export async function publish(page: Page) {
  await page.getByRole('tab', { name: 'Settings & sharing' }).click();
  await page.getByRole('button', { name: 'Publish event' }).click();
  await expect(page.getByText('Status: Active')).toBeVisible();
  return page.getByLabel('Public link').inputValue();
}

/** A real short H.264/AAC clip generated with the bundled ffmpeg (so uploads go through real conversion). */
export async function video(name: string, seconds = 2) {
  const dir = await mkdtemp(join(tmpdir(), 'iu-e2e-'));
  const out = join(dir, 'clip.mp4');
  try {
    await promisify(execFile)(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', out]);
    return { name, mimeType: 'video/mp4', buffer: await readFile(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
