import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { type Locator, type Page, expect, test } from "@playwright/test";

const pageUrl = "https://eamena.org/embedded-pdf-test";
const pdfRenderScale = 0.5;
const pdfJsModuleUrl = "https://pdfjs.local/pdf.mjs";
const pdfWorkerUrl = "https://pdfjs.local/pdf.worker.mjs";

const require = createRequire(path.join(process.cwd(), "package.json"));
const pdfJsPath = require.resolve("pdfjs-dist/build/pdf.mjs");
const pdfWorkerPath = require.resolve("pdfjs-dist/build/pdf.worker.mjs");

type PdfViewport = {
  width: number;
  height: number;
};

type PdfPageProxy = {
  getViewport: (params: { scale: number }) => PdfViewport;
  render: (params: {
    canvas: HTMLCanvasElement;
    viewport: PdfViewport;
  }) => { promise: Promise<void> };
};

type PdfDocumentProxy = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageProxy>;
};

type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (params: { data: Uint8Array }) => {
    promise: Promise<PdfDocumentProxy>;
  };
};

type RenderArgs = {
  base64: string;
  pdfJsModuleUrl: string;
  pdfWorkerUrl: string;
  scale: number;
};

async function readPdfAddress(page: Page): Promise<string> {
  const src = await page.locator('iframe[src$=".pdf"]').getAttribute("src");
  if (src === null || src.length === 0) {
    throw new Error("PDF iframe src was empty");
  }
  return new URL(src, page.url()).href;
}

async function downloadPdf(
  page: Page,
  pdfUrl: string,
  savePath: string,
): Promise<void> {
  const cookieBanner = page.locator("#ccc");
  if ((await cookieBanner.count()) > 0) {
    await cookieBanner.evaluate((banner) => {
      banner.remove();
    });
  }

  await page.evaluate((url: string) => {
    const link = document.createElement("a");
    link.href = url;
    link.download = "eamena.pdf";
    link.id = "pdf-download";
    link.textContent = "Download PDF";
    link.style.position = "fixed";
    link.style.top = "8px";
    link.style.left = "8px";
    link.style.zIndex = "2147483647";
    document.body.appendChild(link);
  }, pdfUrl);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#pdf-download").click();
  const download = await downloadPromise;
  await download.saveAs(savePath);
}

async function renderSavedPdf(page: Page, savePath: string): Promise<Locator> {
  const pdfBase64 = (await readFile(savePath)).toString("base64");
  const viewer = await page.context().newPage();

  await viewer.route(pdfJsModuleUrl, (route) =>
    route.fulfill({
      path: pdfJsPath,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "text/javascript",
      },
    }),
  );
  await viewer.route(pdfWorkerUrl, (route) =>
    route.fulfill({
      path: pdfWorkerPath,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "text/javascript",
      },
    }),
  );

  await viewer.setContent(`<!DOCTYPE html>
<html>
  <head>
    <style>
      html, body { margin: 0; background: #ffffff; }
      canvas { display: block; }
    </style>
  </head>
  <body>
    <canvas id="pdf-canvas"></canvas>
  </body>
</html>`);

  await viewer.evaluate(
    async ({ base64, pdfJsModuleUrl: moduleUrl, pdfWorkerUrl: workerUrl, scale }: RenderArgs) => {
      await import(workerUrl);
      const pdfjs = (await import(moduleUrl)) as PdfJsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const pdf = await pdfjs.getDocument({ data: bytes }).promise;
      const rendered: HTMLCanvasElement[] = [];
      let width = 0;
      let height = 0;

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pdfPage = await pdf.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale });
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = Math.ceil(viewport.width);
        pageCanvas.height = Math.ceil(viewport.height);
        await pdfPage.render({ canvas: pageCanvas, viewport }).promise;
        rendered.push(pageCanvas);
        width = Math.max(width, pageCanvas.width);
        height += pageCanvas.height;
      }

      const canvas = document.querySelector("#pdf-canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("PDF canvas was not created");
      }
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("Canvas 2D context was not available");
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);

      let offsetY = 0;
      for (const pageCanvas of rendered) {
        context.drawImage(pageCanvas, 0, offsetY);
        offsetY += pageCanvas.height;
      }

      await document.fonts.ready;
    },
    {
      base64: pdfBase64,
      pdfJsModuleUrl,
      pdfWorkerUrl,
      scale: pdfRenderScale,
    },
  );

  return viewer.locator("#pdf-canvas");
}

async function comparePdfScreenshot(canvas: Locator): Promise<void> {
  // 0.02 tolerates antialiasing; a real layout change still exceeds it.
  await expect(canvas).toHaveScreenshot("eamena-pdf.png", {
    maxDiffPixelRatio: 0.02,
  });
}

test("downloaded PDF matches the visual baseline", async ({ page }, testInfo) => {
  await page.goto(pageUrl);
  const pdfUrl = await readPdfAddress(page);
  const savePath = testInfo.outputPath("eamena.pdf");
  await downloadPdf(page, pdfUrl, savePath);
  const canvas = await renderSavedPdf(page, savePath);
  await comparePdfScreenshot(canvas);
});
