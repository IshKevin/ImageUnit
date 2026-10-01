import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

// Bundled static binaries by default (identical in dev, CI and Docker); override with FFMPEG_PATH / FFPROBE_PATH.
export const ffmpegBin = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
export const ffprobeBin = process.env.FFPROBE_PATH || ffprobeStatic.path;

export class ToolError extends Error {
  constructor(message: string, readonly code: number | null, readonly signal: NodeJS.Signals | null, readonly stderr: string) {
    super(message);
  }
}

/** Runs a binary without a shell; resolves with stdout, rejects with a ToolError carrying the stderr tail. */
export function run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new ToolError(`could not start ${bin}: ${e.message}`, null, null, err));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new ToolError(`${bin} exited with ${code ?? signal}`, code, signal, err));
    });
  });
}

export interface VideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  createdAt: Date | null;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  const json = JSON.parse(await run(ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 }));
  const streams: Record<string, unknown>[] = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  if (!v) throw new Error('no video stream');
  let width = Number(v.width) || 0;
  let height = Number(v.height) || 0;
  // Phone footage is often stored sideways with a rotation flag; report the dimensions people actually see.
  const rotation = Math.abs(Number(((v.side_data_list as { rotation?: number }[] | undefined) ?? []).find((d) => d.rotation !== undefined)?.rotation ?? (v.tags as { rotate?: string } | undefined)?.rotate ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const created = (json.format?.tags?.creation_time as string | undefined) ?? (v.tags as { creation_time?: string } | undefined)?.creation_time;
  const date = created ? new Date(created) : null;
  return {
    durationSeconds: Number(json.format?.duration ?? v.duration) || 0,
    width,
    height,
    codec: String(v.codec_name ?? 'unknown'),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    createdAt: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}
