import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import { photos } from '../db/schema.js';
import { ffmpegBin, probeVideo, run, ToolError } from '../lib/ffmpeg.js';
import { ALLOWED_TYPES } from '../lib/media.js';
import { notifyIfBatchDone, PermanentProcessingError } from './process-photo.js';

const TRANSCODE_TIMEOUT_MS = 45 * 60 * 1000;
const THUMB_EDGE = 640;

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

async function sniffMime(file: string) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(4100);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return (await fileTypeFromBuffer(buf.subarray(0, bytesRead)))?.mime;
  } finally {
    await fh.close();
  }
}

/**
 * Video pipeline: the original is never modified. We create a web-playable H.264/AAC MP4 (max 1920 px wide, faststart so
 * playback begins before the download ends) and a poster frame, then flip the row to ready.
 */
export async function processVideo(ctx: AppContext, photoId: string): Promise<'ready' | 'skipped'> {
  const [photo] = await ctx.db.select().from(photos).where(eq(photos.id, photoId));
  if (!photo || photo.status === 'ready' || photo.status === 'pending_upload') return 'skipped';

  await ctx.db.update(photos).set({ status: 'processing' }).where(eq(photos.id, photoId));
  const dir = await mkdtemp(join(tmpdir(), 'iu-video-'));
  try {
    const source = join(dir, 'source');
    try {
      await ctx.storage.downloadToFile(photo.originalKey, source);
    } catch {
      throw new PermanentProcessingError('Original file is missing from storage; upload it again');
    }

    // Trust the bytes, not the declared type or extension.
    const mime = await sniffMime(source);
    if (!mime || !mime.startsWith('video/') || !(mime in ALLOWED_TYPES)) throw new PermanentProcessingError('File is not a supported video');

    let info;
    try {
      info = await probeVideo(source);
    } catch (err) {
      throw new PermanentProcessingError(`Video could not be read: ${(err as Error).message}`);
    }
    if (!info.width || !info.height) throw new PermanentProcessingError('Video has no dimensions');

    const posterJpg = join(dir, 'poster.jpg');
    const previewMp4 = join(dir, 'preview.mp4');
    try {
      // Poster: a frame from near the start (or the middle of very short clips).
      const at = Math.min(1, info.durationSeconds / 2).toFixed(2);
      await run(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-ss', at, '-i', source, '-frames:v', '1', '-q:v', '3', '-y', posterJpg], { timeoutMs: 120_000 });
      await run(
        ffmpegBin,
        [
          '-hide_banner', '-loglevel', 'error', '-i', source,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', 'scale=trunc(min(1920\\,iw)/2)*2:-2',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          '-movflags', '+faststart', '-threads', '2', '-y', previewMp4,
        ],
        { timeoutMs: TRANSCODE_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof ToolError) {
        // Killed by the OS (out of memory) or by our timeout is worth another attempt; a decoder error is not.
        if (err.signal) throw new Error(`ffmpeg was interrupted (${err.signal})`);
        throw new PermanentProcessingError(`Video could not be converted: ${err.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || err.message}`);
      }
      throw err;
    }

    const poster = await sharp(posterJpg).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
    const previewKey = `events/${photo.eventId}/previews/${photo.id}.mp4`;
    const thumbKey = `events/${photo.eventId}/thumbs/${photo.id}.webp`;
    await Promise.all([ctx.storage.uploadFile(previewKey, previewMp4, 'video/mp4'), ctx.storage.put(thumbKey, poster, 'image/webp')]);
    const previewSize = (await (await open(previewMp4, 'r')).stat()).size;

    await ctx.db
      .update(photos)
      .set({
        status: 'ready',
        error: null,
        width: info.width,
        height: info.height,
        durationSeconds: info.durationSeconds,
        format: ALLOWED_TYPES[mime],
        checksum: await sha256File(source),
        previewKey,
        thumbKey,
        previewSizeBytes: previewSize,
        thumbSizeBytes: poster.length,
        takenAt: info.createdAt,
        exif: { codec: info.codec, hasAudio: info.hasAudio },
      })
      .where(eq(photos.id, photoId));

    await notifyIfBatchDone(ctx, photo.eventId);
    return 'ready';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
