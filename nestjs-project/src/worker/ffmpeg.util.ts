import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface ProbedMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`${command} exited with code ${code}: ${stderr.trim()}`),
        );
      }
    });
  });
}

export async function probeVideo(filePath: string): Promise<ProbedMetadata> {
  const stdout = await runCommand('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error('No video stream found in the uploaded file');
  }

  return {
    durationSeconds: Math.round(Number(parsed.format?.duration ?? 0)),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    codec: videoStream.codec_name ?? 'unknown',
    bitrate: Number(videoStream.bit_rate ?? parsed.format?.bit_rate ?? 0),
  };
}

export async function generateThumbnail(
  filePath: string,
  outputPath: string,
): Promise<void> {
  await runCommand('ffmpeg', [
    '-y',
    '-i',
    filePath,
    '-ss',
    '00:00:00.5',
    '-vframes',
    '1',
    outputPath,
  ]);

  // ffmpeg can exit 0 without writing a frame (e.g., seek target at/past the
  // end of a very short clip) — treat a missing/empty output as a failure so
  // it's caught alongside other deterministic media errors, not surfaced as
  // an unhandled crash later when the caller tries to read the file.
  const output = await stat(outputPath).catch(() => null);
  if (!output || output.size === 0) {
    throw new Error('ffmpeg did not produce a thumbnail frame');
  }
}
