// 実サイトの代表Stepを読み取り、配布スクリプトを一時実行して結果を記録する。
// 大学側への書き込みや、音声の一括ダウンロードは行わない。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium } from "playwright";

const reportPath = process.argv[2];
const outputPath = process.argv[3] || "test-results/live-smoke.json";
const width = Number(process.env.TUFS_LIVE_WIDTH || 1440);
if (!reportPath) throw new Error("構造調査JSONのパスを指定してください。");
const report = JSON.parse(await readFile(reportPath, "utf8"));
if (!Array.isArray(report.results) || !report.results.length ||
    report.results.some((item) => item.status !== "sampled" || !item.pages?.length)) {
  throw new Error("構造調査に未取得の区分があるか、検証対象がありません。調査結果を確認してください。");
}
const source = await readFile("tufs-grammar-unified-view.user.js", "utf8");
const browser = await chromium.launch({ channel: process.env.TUFS_BROWSER_CHANNEL || "msedge", headless: true });
const results = [];
const browserVersion = browser.version();
await mkdir("test-results", { recursive: true });
await mkdir(path.dirname(outputPath), { recursive: true });
try {
  for (const sample of report.results.filter((item) => item.status === "sampled")) {
    const url = sample.pages[0].url;
    const language = new URL(url).pathname.split("/")[2];
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const result = { language, url, errors: [] };
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("[TUFS Unified]")) result.errors.push(message.text());
    });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.addScriptTag({ content: source });
      await page.waitForFunction(() => {
        const root = document.querySelector("#tufs-unified-host")?.shadowRoot;
        return root && !root.querySelector('[aria-busy="true"]');
      }, null, { timeout: 30000 });
      result.frameUrls = page.frames().slice(1).map((frame) => frame.url());
      result.expectedUrls = sample.pages[0].page_links;
      result.sectionErrors = await page.locator(".tufs-section-error").count();
      result.audioItems = await page.locator(".tufs-audio-item").count();
      result.audioMessage = await page.locator(".tufs-audio-message").allTextContents();
      result.frames = [];
      for (const frame of page.frames().slice(1)) {
        result.frames.push(await frame.evaluate(() => ({
          url: location.href,
          bodyWidth: document.body.scrollWidth,
          viewportWidth: innerWidth,
          contentHeight: document.querySelector("#content_box")?.scrollHeight,
          recursiveHost: Boolean(document.querySelector("#tufs-unified-host")),
        })));
      }
      result.passed = !result.sectionErrors && !result.errors.length &&
        result.frameUrls.length === result.expectedUrls.length &&
        result.frameUrls.every((u) => result.expectedUrls.includes(u)) &&
        result.frames.every((frame) => !frame.recursiveHost && frame.bodyWidth <= frame.viewportWidth + 2);
      if (["ko", "ja", "ur", "ar"].includes(language)) {
        result.screenshot = `${outputPath.replace(/\.json$/, "")}-${language}-${results.length}.png`;
        await page.screenshot({ path: result.screenshot, fullPage: true });
      }
    } catch (error) {
      result.passed = false;
      result.errors.push(error.message);
    } finally { await page.close(); }
    results.push(result);
    console.log(language, result.passed ? "PASS" : "FAIL", result.audioItems ?? "?", result.errors);
  }
} finally { await browser.close(); }
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify({
  checkedAt: new Date().toISOString(), browserVersion, viewportWidth: width,
  sourceSha256: createHash("sha256").update(source).digest("hex"), results,
}, null, 2) + "\n");
if (results.some((result) => !result.passed)) process.exitCode = 1;
