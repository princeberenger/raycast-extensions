import { open, showInFinder, showToast, Toast } from "@raycast/api";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { fetchFontshare } from "./api";

const SHOW_FILE_TITLE = process.platform === "darwin" ? "Show in Finder" : "Show in Explorer";

function fileNameFrom(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  // basename() drops any path a malicious header could carry.
  return basename(name?.trim() || fallback);
}

// Never overwrite an earlier download: "Satoshi_Complete.zip" becomes "Satoshi_Complete 2.zip".
function availablePath(dir: string, fileName: string): string {
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  let candidate = join(dir, fileName);
  for (let index = 2; existsSync(candidate); index++) {
    candidate = join(dir, `${stem} ${index}${extension}`);
  }
  return candidate;
}

/** Downloads a Fontshare zip to the user's Downloads folder and reports progress with a toast. */
export async function downloadZip(url: string, title: string, fallbackFileName: string): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: `Downloading ${title}…` });

  try {
    const response = await fetchFontshare(url);
    const dir = join(homedir(), "Downloads");
    await mkdir(dir, { recursive: true });
    const file = availablePath(dir, fileNameFrom(response, fallbackFileName));
    await writeFile(file, Buffer.from(await response.arrayBuffer()));

    toast.style = Toast.Style.Success;
    toast.title = `Downloaded ${title}`;
    toast.message = basename(file);
    toast.primaryAction = { title: SHOW_FILE_TITLE, onAction: () => showInFinder(file) };
    toast.secondaryAction = { title: "Open", onAction: () => open(file) };
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = `Could not download ${title}`;
    toast.message = error instanceof Error ? error.message : String(error);
  }
}
