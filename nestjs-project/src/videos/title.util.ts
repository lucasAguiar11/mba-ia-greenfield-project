import { extname } from 'node:path';

const MAX_TITLE_LENGTH = 255;
const DEFAULT_TITLE = 'Untitled video';

/** Derives a video's display title from its uploaded filename (per phase-03-videos/TD-07 note) — extension stripped, whitespace collapsed. */
export function deriveTitleFromFilename(filename: string): string {
  const withoutExtension = filename.slice(
    0,
    filename.length - extname(filename).length,
  );
  const sanitized = withoutExtension.replace(/\s+/g, ' ').trim();
  return (sanitized || DEFAULT_TITLE).slice(0, MAX_TITLE_LENGTH);
}
