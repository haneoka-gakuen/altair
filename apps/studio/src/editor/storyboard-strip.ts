import { downloadStudioFile } from "./studio-host";

const pageHeight = 8192;
const width = 512;
const captionHeight = 34;

export async function exportStoryboardStrip<Item>(
  shots: readonly Item[],
  capture: (shot: Item) => Promise<{ image: string; caption: string }>,
  signal: AbortSignal,
): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Stage capture is unavailable");
  const theme = getComputedStyle(document.documentElement);
  const surface = theme.getPropertyValue("--md-sys-color-surface").trim() || "white";
  const ink = theme.getPropertyValue("--md-sys-color-on-surface").trim() || "black";
  const font = theme.fontFamily;
  const pages: { path: string; blob: Blob }[] = [];
  let imageHeight = 0;
  let rows = 0;
  let row = 0;
  const finishPage = async () => {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Stage capture is unavailable"))),
        "image/png",
      );
    });
    signal.throwIfAborted();
    pages.push({ path: `storyboard-${pages.length + 1}.png`, blob });
    row = 0;
  };
  for (const [index, shot] of shots.entries()) {
    signal.throwIfAborted();
    const { image, caption } = await capture(shot);
    const bitmap = await createImageBitmap(await (await fetch(image, { signal })).blob());
    try {
      signal.throwIfAborted();
      if (!imageHeight) {
        imageHeight = Math.max(
          1,
          Math.min(pageHeight - captionHeight, Math.round((bitmap.height * width) / bitmap.width)),
        );
        rows = Math.max(1, Math.floor(pageHeight / (imageHeight + captionHeight)));
      }
      const height = imageHeight + captionHeight;
      if (!row) canvas.height = Math.min(shots.length - index, rows) * height;
      const top = row * height;
      context.fillStyle = surface;
      context.fillRect(0, top, width, height);
      const scale = Math.min(width / bitmap.width, imageHeight / bitmap.height);
      const imageWidth = bitmap.width * scale;
      const displayHeight = bitmap.height * scale;
      context.drawImage(
        bitmap,
        (width - imageWidth) / 2,
        top + (imageHeight - displayHeight) / 2,
        imageWidth,
        displayHeight,
      );
      context.fillStyle = ink;
      context.font = `14px ${font}`;
      context.textBaseline = "middle";
      context.fillText(caption.replace(/\s+/gu, " "), 12, top + imageHeight + captionHeight / 2, width - 24);
      row++;
      if (row === rows || index === shots.length - 1) await finishPage();
    } finally {
      bitmap.close();
    }
  }
  if (pages.length === 1) downloadStudioFile(pages[0]!.blob, "storyboard.png");
  else if (pages.length) {
    const { createFilesZip } = await import("./archive");
    const archive = await createFilesZip(pages);
    signal.throwIfAborted();
    downloadStudioFile(archive, "storyboard.zip");
  }
}
