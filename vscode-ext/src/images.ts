/**
 * Local images for the preview: read the file a Markdown `<img src>` names,
 * relative to the source document, and hand it back as a `data:` URI.
 *
 * Mirrors UniNotepad's `read_image` (src-tauri/src/commands/file.rs). The webview
 * cannot load the document's folder — `localResourceRoots` covers only the
 * extension — and widening that would expose the whole folder to the webview.
 * Shipping the bytes instead keeps the CSP at `img-src … data:`, renders an SVG
 * through `<img>` (no script, no external fetches), and makes an HTML export
 * self-contained. Going through `workspace.fs` rather than Node's `fs` means a
 * remote or virtual workspace works too.
 */
import * as vscode from "vscode";

/** Refused past this: the bytes cross the message channel base64-encoded. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The read policy as much as a MIME table: a document can name any path, so
 *  only files that are plainly images are read on its behalf. */
const IMAGE_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** Two or more letters before the colon, so a Windows drive stays a path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

export interface ImageReply {
  mtimeMs: number | null;
  dataUri: string | null;
}

/** The candidate URIs for a src, decoded spelling first: `a%20b.svg` usually
 *  means a space, but a file whose name really holds a `%` should still load. */
function candidates(docUri: vscode.Uri, src: string): vscode.Uri[] {
  const hash = src.indexOf("#");
  const raw = hash === -1 ? src : src.slice(0, hash);
  if (raw === "") throw new Error("Empty image source");
  if (/^file:/i.test(raw)) return [vscode.Uri.parse(raw)];
  if (HAS_SCHEME.test(raw)) throw new Error(`Unsupported image source: ${src}`);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escape: take the src literally.
  }
  const spellings = decoded === raw ? [raw] : [decoded, raw];
  return spellings.map((p) => {
    if (p.startsWith("/") || /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\")) {
      return docUri.scheme === "file" ? vscode.Uri.file(p) : docUri.with({ path: p });
    }
    if (docUri.scheme === "untitled") {
      throw new Error("Save this document first to show relative images");
    }
    return vscode.Uri.joinPath(docUri, "..", p);
  });
}

async function readOne(uri: vscode.Uri, knownMtime: number | null): Promise<ImageReply> {
  const ext = (uri.path.split(".").pop() ?? "").toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`${uri.path}: not a supported image type`);
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.File) === 0) throw new Error(`${uri.path}: not a file`);
  if (stat.size > IMAGE_MAX_BYTES) {
    throw new Error(
      `${uri.path}: image is ${Math.floor(stat.size / (1024 * 1024))} MB, over the ` +
        `${IMAGE_MAX_BYTES / (1024 * 1024)} MB preview limit`,
    );
  }
  if (stat.mtime === knownMtime) return { mtimeMs: stat.mtime, dataUri: null };
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    mtimeMs: stat.mtime,
    dataUri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

/** Read the image `src` names, relative to `docUri`. Throws with a message fit
 *  for the image's tooltip. */
export async function readPreviewImage(
  docUri: vscode.Uri,
  src: string,
  knownMtime: number | null,
): Promise<ImageReply> {
  const uris = candidates(docUri, src);
  let firstErr: unknown;
  for (const uri of uris) {
    try {
      return await readOne(uri, knownMtime);
    } catch (e) {
      // The decoded spelling's error is the one worth showing.
      firstErr ??= e;
    }
  }
  throw firstErr;
}
