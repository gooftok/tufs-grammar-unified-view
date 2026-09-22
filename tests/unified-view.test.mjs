import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { chromium } from "playwright";

const port = "18765";
const origin = `http://127.0.0.1:${port}`;
let server;
let browser;

before(async () => {
  server = spawn(process.execPath, ["tests/smoke-server.mjs"], {
    env: { ...process.env, TUFS_SMOKE_PORT: port }, stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(() => { throw new Error("検証サーバーを起動できませんでした。"); }),
  ]);
  browser = await chromium.launch({ channel: process.env.TUFS_BROWSER_CHANNEL || "msedge", headless: true });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

function url(language = "ko", type = "card", file = "401.html") {
  return `${origin}/mt/${language}/gmod/courses/c03/lesson01/step1/${type}/${file}`;
}

async function open(language = "ko", type = "card") {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url(language, type));
  await page.locator("#tufs-unified-host").waitFor();
  await page.waitForFunction(() => {
    const root = document.querySelector("#tufs-unified-host")?.shadowRoot;
    return root && !root.querySelector('[aria-busy="true"]');
  });
  assert.equal(await page.locator(".tufs-section-error").count(), 0);
  assert.deepEqual(errors, []);
  return page;
}

test("韓国語の4画面、再帰防止、完全一致音声、練習問題、ZIP、再読み込み", async () => {
  const page = await open();
  try {
    assert.equal(page.frames().length, 5);
    for (const frame of page.frames().slice(1)) {
      assert.equal(await frame.locator("#tufs-unified-host").count(), 0);
    }
    const explanation = page.frames().find((f) => f.url().includes("/explanation/"));
    const instances = page.frames().find((f) => f.url().includes("/instances/"));
    assert.equal(await explanation.locator(".tufs-unified-explanation-audio").count(), 2);
    await explanation.locator(".tufs-unified-explanation-audio").first().click();
    assert.equal(await instances.locator("html").getAttribute("data-last-played"), "sample-1.mp3");
    const exercises = page.frames().find((f) => f.url().includes("/exercises/"));
    await exercises.getByRole("link", { name: "Check Answer" }).click();
    await exercises.locator("#answerBlock0").waitFor({ state: "visible" });
    assert.equal(await exercises.locator("#answerBlock0").isVisible(), true);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /一括DL/ }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /TUFS_ko_c03_lesson01_step1_audio\.zip/);
    assert.equal(await download.failure(), null);
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#tufs-unified-host").shadowRoot.querySelector('[aria-busy="true"]'));
    assert.equal(await explanation.locator(".tufs-unified-explanation-audio").count(), 2);
    assert.equal(await page.locator(".tufs-audio-item").count(), 4);
  } finally { await page.close(); }
});

test("言語・方言、タブ文言・タグ、欠けたページを実リンクで扱う", async () => {
  for (const [language, count] of [["en", 3], ["de", 4], ["ar-eg", 2], ["es", 1], ["zh", 2]]) {
    const page = await browser.newPage();
    const requested = [];
    page.on("request", (request) => { if (request.isNavigationRequest()) requested.push(request.url()); });
    try {
      await page.goto(url(language));
      await page.waitForFunction(() => {
        const root = document.querySelector("#tufs-unified-host")?.shadowRoot;
        return root && !root.querySelector('[aria-busy="true"]');
      });
      assert.equal(page.frames().length, count + 1, language);
      assert.equal(await page.locator(".tufs-section-error").count(), 0, language);
      assert.equal(requested.length, count + 1, language);
      assert.ok(requested.every((u) => u.startsWith(`${origin}/mt/${language}/gmod/courses/c03/lesson01/step1/`)), language);
      assert.equal(await page.getByRole("link", { name: "Lesson一覧へ戻る" }).getAttribute("href"),
        `${origin}/mt/${language}/gmod/courses/c03/lesson01/`);
    } finally { await page.close(); }
  }
});

test("解説だけにある音声の代理再生、右から左の文、再読み込み", async () => {
  const page = await open("ar-eg");
  try {
    const explanation = page.frames().find((f) => f.url().includes("/explanation/"));
    assert.equal(await page.locator(".tufs-audio-item").count(), 4);
    assert.equal(await page.locator(".tufs-audio-primary bdi").first().getAttribute("dir"), "auto");
    assert.equal(await page.locator(".tufs-audio-primary").first().textContent(), "(91/a) أنا طالب.");
    assert.deepEqual(await page.locator(".tufs-audio-entry").first().locator(".tufs-audio-translation").allTextContents(),
      ["(私は学生です。)", "[ʔanaa ṭaalib]"]);
    await page.locator(".tufs-audio-item").first().click();
    assert.equal(await explanation.locator("html").getAttribute("data-last-played"), "sample-1.mp3");
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#tufs-unified-host").shadowRoot.querySelector('[aria-busy="true"]'));
    await page.locator(".tufs-audio-item").first().click();
    assert.equal(await explanation.locator("html").getAttribute("data-last-played"), "sample-1.mp3");
  } finally { await page.close(); }
});

test("表記切り替え先の教材番号を全セクションで保持する", async () => {
  const page = await open();
  try {
    await page.getByRole("link", { name: "語幹式", exact: true }).click();
    await page.locator(".tufs-audio-item").first().waitFor();
    assert.equal(page.url(), url("ko", "card", "201.html"));
    assert.ok(page.frames().slice(1).every((f) => f.url().endsWith("/201.html")));
  } finally { await page.close(); }
});

test("原文と訳が別要素でも一致を判定し、訳が異なる例には音声を付けない", async () => {
  const page = await open("de");
  try {
    const explanation = page.frames().find((f) => f.url().includes("/explanation/"));
    assert.equal(await explanation.locator(".tufs-unified-explanation-audio").count(), 1);
    assert.equal(await page.locator(".tufs-audio-primary").first().textContent(), "(1) Ich lerne Deutsch.");
    assert.deepEqual(await page.locator(".tufs-audio-entry").first().locator(".tufs-audio-translation").allTextContents(),
      ["(私はドイツ語を勉強する。)", "[ɪç]"]);
  } finally { await page.close(); }
});

test("折りたたみは言語別で、韓国語の旧設定を引き継ぐ", async () => {
  const page = await open();
  try {
    await page.evaluate(() => localStorage.setItem("tufs-unified.collapsed.card", "true"));
    await page.reload();
    const toggle = page.locator('[data-page-type="card"] .tufs-section-toggle');
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await page.goto(url("en"));
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await toggle.click();
    assert.equal(await page.evaluate(() => localStorage.getItem("tufs-unified.collapsed.en.card")), "true");
  } finally { await page.close(); }
});

test("未知のDOMと通常表示指定では元ページを残す", async () => {
  const page = await browser.newPage();
  try {
    for (const target of [url("xx"), `${url()}?unified=0`]) {
      await page.goto(target);
      assert.equal(await page.locator("#tufs-unified-host").count(), 0);
      assert.equal(await page.locator("#content_box").count(), 1);
      assert.equal(page.frames().length, 1);
    }
  } finally { await page.close(); }
});

test("配布版のURL境界は外部サイト・別分野・未知の階層を拒否する", async () => {
  const source = await readFile("tufs-grammar-unified-view.user.js", "utf8");
  const context = vm.createContext({ URL, window: { top: 1, self: 1 }, console });
  vm.runInContext(source.replace("void main();", "globalThis.testRoute = isSupportedPage;"), context);
  const path = "/mt/ar-eg/gmod/courses/c01/lesson01/step1/card/003.html";
  assert.equal(context.testRoute(new URL(`https://www.coelang.tufs.ac.jp${path}`)), true);
  for (const target of [
    `https://example.com${path}`, `http://www.coelang.tufs.ac.jp${path}`,
    "https://www.coelang.tufs.ac.jp/mt/ja/vmod/",
    "https://www.coelang.tufs.ac.jp/mt/ja/gmod/courses/c01/",
    "https://www.coelang.tufs.ac.jp/mt/ja/other/gmod/courses/c01/lesson01/step1/card/001.html",
    "https://www.coelang.tufs.ac.jp/mt/ja/gmod/courses/c01/lesson01/step1/unknown/001.html",
  ]) assert.equal(context.testRoute(new URL(target)), false, target);
});

test("解説・例文・練習問題から開いても同じStepを統合する", async () => {
  for (const type of ["explanation", "instances", "exercises"]) {
    const page = await open("ko", type);
    try {
      assert.equal(page.frames().length, 5);
      assert.equal(await page.locator(".tufs-audio-item").count(), 4);
      assert.ok(page.frames().slice(1).every((frame) => frame.url().includes("/step1/")));
    } finally { await page.close(); }
  }
});

test("読み込み先が別教材へ転送されたら混在させず、再試行で元のURLへ戻る", async () => {
  const page = await browser.newPage();
  let redirect = true;
  await page.route(url("ko", "instances"), async (route) => {
    if (redirect) await route.fulfill({ status: 302, headers: { location: url("en", "instances") } });
    else await route.continue();
  });
  try {
    await page.goto(url());
    const section = page.locator('[data-page-type="instances"]');
    await section.locator(".tufs-section-status-error").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".tufs-audio-item").count(), 0);
    redirect = false;
    await section.getByRole("button", { name: "再試行" }).click();
    await page.locator(".tufs-audio-item").first().waitFor({ timeout: 5000 });
    assert.ok(page.frames().slice(1).every((frame) => frame.url().includes("/mt/ko/")));
  } finally { await page.close(); }
});

test("音声の一括取得で1件でも失敗したら不完全なZIPを保存しない", async () => {
  const page = await open();
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  try {
    await page.route("**/sound/sample-2.mp3", (route) => route.fulfill({ status: 503, body: "検証用エラー" }));
    await page.getByRole("button", { name: /一括DL/ }).click();
    await page.getByText("一括DLに失敗しました。個別DLを利用してください。").waitFor();
    assert.equal(downloads.length, 0);
    assert.equal(await page.getByRole("button", { name: /一括DL/ }).isEnabled(), true);
  } finally { await page.close(); }
});

test("狭い画面でも全セクションを開ける", async () => {
  const page = await open("ar-eg");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const type of ["card", "explanation", "instances", "exercises"]) {
      const toggle = page.locator(`[data-page-type="${type}"] .tufs-section-toggle`);
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    }
    await page.locator(".tufs-audio-item").first().click();
    const explanation = page.frames().find((frame) => frame.url().includes("/explanation/"));
    assert.equal(await explanation.locator("html").getAttribute("data-last-played"), "sample-1.mp3");
  } finally { await page.close(); }
});
