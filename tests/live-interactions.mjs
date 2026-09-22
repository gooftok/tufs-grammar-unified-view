// 実教材で音声の再生開始と、狭い画面への切り替えを確認する。
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const source = await readFile("tufs-grammar-unified-view.user.js", "utf8");
const samples = JSON.parse(await readFile("tests/site-structure-20260922-final.json", "utf8")).results;
const browser = await chromium.launch({ channel: process.env.TUFS_BROWSER_CHANNEL || "msedge", headless: true });
const results = [];
await mkdir("test-results", { recursive: true });
try {
  for (const language of ["ko", "de", "zh", "ja", "ur", "ar-eg"]) {
    const sample = samples.find((item) => item.root.includes(`/mt/${language}/`));
    const url = sample.pages.find((item) => item.url.includes("/instances/"))?.url ||
      sample.pages.find((item) => item.url.includes("/explanation/"))?.url;
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const result = { language, url, passed: false };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.addScriptTag({ content: source });
      await page.waitForFunction(() => {
        const root = document.querySelector("#tufs-unified-host")?.shadowRoot;
        return root && !root.querySelector('[aria-busy="true"]');
      });
      assert.equal(await page.locator(".tufs-section-error").count(), 0);
      const audioFrame = page.frames().slice(1).find((frame) => frame.url() === url);
      await page.locator(".tufs-audio-item:not([disabled])").first().click();
      // 元ページはDOMに挿入せず new Audio() を audioObj に保持する。
      await audioFrame.waitForFunction(() => [...document.querySelectorAll("audio,video"), window.audioObj].filter(Boolean)
        .some((media) => !media.paused && media.currentTime > 0), null, { timeout: 10000 });
      result.media = await audioFrame.evaluate(() => [...document.querySelectorAll("audio,video"), window.audioObj].filter(Boolean)
        .filter((media) => media.currentTime > 0).map((media) => ({
          src: media.currentSrc, currentTime: media.currentTime, error: media.error?.code || null,
        })));
      await page.setViewportSize({ width: 390, height: 844 });
      result.narrowFrames = [];
      for (const frame of page.frames().slice(1)) {
        result.narrowFrames.push(await frame.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { url: location.href, width: innerWidth, scrollWidth: document.body.scrollWidth };
        }));
      }
      result.outerOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      result.screenshot = `test-results/mobile-${language}.png`;
      await page.screenshot({ path: result.screenshot, fullPage: true });
      assert.equal(result.outerOverflow, false);
      assert.ok(result.narrowFrames.every((frame) => frame.scrollWidth <= frame.width + 2), "狭い画面で本文がはみ出しています。");
      result.passed = true;
    } catch (error) { result.error = error.message; }
    finally { await page.close(); }
    results.push(result);
    console.log(language, result.passed ? "PASS" : "FAIL", result.error || result.media);
  }
} finally { await browser.close(); }
await writeFile("test-results/live-interactions-20260922.json", JSON.stringify({
  checkedAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(source).digest("hex"), results,
}, null, 2) + "\n");
if (results.some((result) => !result.passed)) process.exitCode = 1;
