import { environment } from "@raycast/api";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useEffect, useMemo, useState } from "react";
import { Font, FontPair } from "./api";
import { renderPairSvg, renderSampleSvg, renderTextSvg } from "./render-svg";

// Blank image shown while a preview renders: built-in icons would fill the whole grid cell.
export const PREVIEW_PLACEHOLDER = "preview-placeholder.svg";

const CONCURRENCY = 6;
// Bump when the rendering changes so stale images are regenerated.
const RENDER_VERSION = 5;
// Raycast grids scale images so that only their top-left 90% fills the cell (measured with a calibration image),
// which crops the right and bottom edges. Previews add a matching transparent margin there.
const GRID_VISIBLE_FRACTION = 0.9;

export interface RenderedImages {
  files: Record<string, string>;
  // True while some images are still being rendered for the first time.
  isRendering: boolean;
}

interface RenderJob {
  id: string;
  fileName: string;
  render: () => Promise<string>;
}

function cacheDir(cache: string): string {
  return join(environment.supportPath, `${cache}-v${RENDER_VERSION}`);
}

async function removeStaleCaches(cache: string): Promise<void> {
  const current = `${cache}-v${RENDER_VERSION}`;
  const entries = await readdir(environment.supportPath).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(cache) && entry !== current)
      .map((entry) => rm(join(environment.supportPath, entry), { recursive: true, force: true })),
  );
}

/** Extends the SVG canvas to the right and bottom so the drawing exactly fills a Raycast grid cell. */
function fitGridCell(svg: string): string {
  return svg.replace(/<svg ([^>]*)>/, (_, attributes: string) => {
    const scaled = attributes
      .replace(/viewBox="([^"]+)"/, (_, viewBox: string) => {
        const [x, y, width, height] = viewBox.split(" ").map(Number);
        const size = [width, height].map((n) => (n / GRID_VISIBLE_FRACTION).toFixed(2));
        return `viewBox="${x} ${y} ${size.join(" ")}"`;
      })
      .replace(/(width|height)="([^"]+)"/g, (_, name: string, value: string) => {
        return `${name}="${(Number(value) / GRID_VISIBLE_FRACTION).toFixed(2)}"`;
      });
    return `<svg ${scaled}>`;
  });
}

// Pairs reuse the same font files, so share downloads within a session.
const fontData = new Map<string, Promise<ArrayBuffer>>();

function fetchFontData(url: string): Promise<ArrayBuffer> {
  let data = fontData.get(url);
  if (!data) {
    data = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Font file responded with ${response.status}`);
      return response.arrayBuffer();
    });
    data.catch(() => fontData.delete(url));
    fontData.set(url, data);
  }
  return data;
}

/** Returns the cached SVG path of each job, rendering missing ones in the background. */
function useRenderedImages(cache: string, jobs: RenderJob[] | undefined): RenderedImages {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(0);

  useEffect(() => {
    if (!jobs) {
      return;
    }

    let cancelled = false;
    const dir = cacheDir(cache);
    const cached: Record<string, string> = {};
    const queue: (RenderJob & { file: string })[] = [];

    for (const job of jobs) {
      const file = join(dir, job.fileName);
      if (existsSync(file)) {
        cached[job.id] = file;
      } else {
        queue.push({ ...job, file });
      }
    }
    setFiles(cached);
    setPending(queue.length);
    removeStaleCaches(cache).catch((error) => console.error(`Could not remove stale ${cache}`, error));

    const worker = async () => {
      for (let job = queue.shift(); job && !cancelled; job = queue.shift()) {
        try {
          const svg = fitGridCell(await job.render());
          await mkdir(dir, { recursive: true });
          // Write then rename so a cancelled run never leaves a truncated file in the cache.
          await writeFile(`${job.file}.tmp`, svg);
          await rename(`${job.file}.tmp`, job.file);
          const { id, file } = job;
          if (!cancelled) setFiles((current) => ({ ...current, [id]: file }));
        } catch (error) {
          console.error(`Could not render ${cache} image ${job.id}`, error);
        }
        if (!cancelled) setPending((count) => count - 1);
      }
    };
    Promise.all(Array.from({ length: CONCURRENCY }, worker));

    return () => {
      cancelled = true;
    };
  }, [cache, jobs]);

  return { files, isRendering: pending > 0 };
}

/** "Aa" previews keyed by font id. */
export function useFontPreviews(fonts: Font[] | undefined, enabled: boolean): RenderedImages {
  const jobs = useMemo(
    () =>
      enabled
        ? fonts?.flatMap((font) => {
            const preview = font.preview;
            if (!preview) return [];
            return {
              id: font.id,
              fileName: `${font.id}-${preview.styleId}.svg`,
              render: async () => renderSampleSvg(await fetchFontData(preview.woffUrl)),
            };
          })
        : undefined,
    [fonts, enabled],
  );
  return useRenderedImages("previews", jobs);
}

/** Pairing cards keyed by pair id. */
export function usePairPreviews(pairs: FontPair[] | undefined): RenderedImages {
  const jobs = useMemo(
    () =>
      pairs?.map((pair) => ({
        id: pair.id,
        fileName: `${pair.id}-${pair.headline.styleId}-${pair.body.styleId}.svg`,
        render: async () => {
          const [headline, body] = await Promise.all([
            fetchFontData(pair.headline.woffUrl),
            fetchFontData(pair.body.woffUrl),
          ]);
          return renderPairSvg(
            { data: headline, text: pair.headline.text, size: pair.headline.size },
            { data: body, text: pair.body.text, size: pair.body.size },
          );
        },
      })),
    [pairs],
  );
  return useRenderedImages("pairs", jobs);
}

/** Previews of `text` keyed by font id. Only the images of the current text are kept on disk. */
export function useTextPreviews(fonts: Font[] | undefined, text: string): RenderedImages {
  const textKey = useMemo(() => createHash("sha1").update(text).digest("hex").slice(0, 12), [text]);

  useEffect(() => {
    const dir = cacheDir("texts");
    readdir(dir)
      .then((files) =>
        Promise.all(
          files.filter((file) => !file.startsWith(`${textKey}-`)).map((file) => rm(join(dir, file), { force: true })),
        ),
      )
      .catch(() => {
        // Nothing cached yet.
      });
  }, [textKey]);

  const jobs = useMemo(
    () =>
      fonts?.flatMap((font) => {
        const preview = font.preview;
        if (!preview) return [];
        return {
          id: font.id,
          fileName: `${textKey}-${font.id}-${preview.styleId}.svg`,
          render: async () => renderTextSvg(await fetchFontData(preview.woffUrl), text),
        };
      }),
    [fonts, text, textKey],
  );
  return useRenderedImages("texts", jobs);
}

/**
 * Markdown images don't support `tintColor` reliably, so write a copy of the SVG filled with a color that suits the
 * current appearance and return its path.
 */
export function themedSvg(file: string): string {
  const themed = file.replace(/\.svg$/, `-${environment.appearance}.svg`);
  if (!existsSync(themed)) {
    const fill = environment.appearance === "dark" ? "#ececec" : "#1c1c1c";
    writeFileSync(themed, readFileSync(file, "utf8").replace("<svg ", `<svg fill="${fill}" `));
  }
  return themed;
}
