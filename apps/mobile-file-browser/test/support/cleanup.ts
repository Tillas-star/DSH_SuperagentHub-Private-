import { promises as fs } from 'node:fs';

/**
 * Remove a temporary directory without letting a locked file (common on
 * Windows with sharp/antivirus) hang the test hook. CI runners discard their
 * temp directories anyway; this is best-effort cleanup.
 */
export async function removeTempDir(dir: string): Promise<void> {
  const cleanup = fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await Promise.race([
    cleanup,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
    }),
  ]);
}
