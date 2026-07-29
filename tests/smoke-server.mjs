import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.TUFS_SMOKE_PORT || "8765", 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, "..", "tufs-grammar-unified-view.user.js");

const routes = {
  card: "/mt/ko/gmod/courses/c03/lesson01/step1/card/401.html",
  explanation:
    "/mt/ko/gmod/courses/c03/lesson01/step1/explanation/401.html",
  instances: "/mt/ko/gmod/courses/c03/lesson01/step1/instances/401.html",
  exercises: "/mt/ko/gmod/courses/c03/lesson01/step1/exercises/401.html",
  next: "/mt/ko/gmod/courses/c03/lesson01/step2/card/402.html",
};

const userscript = (await readFile(scriptPath, "utf8")).replace(
  'url.origin === "https://www.coelang.tufs.ac.jp"',
  "url.origin === window.location.origin",
);

function navigation(pageType) {
  const labels = {
    card: "カード",
    explanation: "解説",
    instances: "例文",
    exercises: "練習問題",
  };

  return `
    <nav class="clearfix" id="gmodnav">
      <div class="gra_in_menu_container clearfix">
        ${Object.entries(labels)
          .map(
            ([type, label]) =>
              `<p class="${type === pageType ? "gra_in_menu" : "gra_in_menu_off"}">
                <a href="${routes[type]}">${label}</a>
              </p>`,
          )
          .join("")}
      </div>
      <div class="gra_in_backnext clearfix">
        <div id="gra_step_back_off"><span>前のレッスン</span></div>
        <div id="gra_step_next"><a href="${routes.next}">次のステップ</a></div>
      </div>
    </nav>
  `;
}

function pageContent(pageType) {
  if (pageType === "card") {
    return `
      <div class="contents">
        <section id="card_box">
          <p>한국어입니다.</p>
          <p>韓国語です。</p>
        </section>
      </div>
    `;
  }

  if (pageType === "explanation") {
    return `
      <div class="contents">
        <section id="explanation_box">
          <p>指定詞です。名詞の後ろに付きます。</p>
          <div class="instance">
            <span class="instance_t">(1)한국어입니다.(韓国語です。)</span>
            <div class="voiceLinkBox"></div>
          </div>
          <div class="instance">
            <span class="instance_t">(2)책입니다.(本です。)</span>
            <div class="voiceLinkBox"></div>
          </div>
          <div class="instance">
            <span class="instance_t">(3)중복입니다.(重複です。)</span>
            <div class="voiceLinkBox"></div>
          </div>
          <div class="instance">
            <span class="instance_t">(9)이것은 일치하지 않습니다.(これは一致しません。)</span>
            <div class="voiceLinkBox"></div>
          </div>
        </section>
      </div>
    `;
  }

  if (pageType === "instances") {
    return `
      <div class="contents">
        <section id="instances_box">
          <div class="instance gra_dl_box">
            <div class="instTxtBlk">
              <span class="instance_t">(1)한국어입니다.(韓国語です。)</span>
            </div>
            <div class="voiceLinkBox">
              <a href="javascript:playItem('sample-1.mp3')">
                <img alt="音声を再生" src="/pixel.svg">
              </a>
              <a href="/sound/sample-1.mp3">
                <img alt="音声をダウンロード" src="/pixel.svg">
              </a>
            </div>
          </div>
          <div class="instance gra_dl_box">
            <div class="instTxtBlk">
              <span class="instance_t">(2)책입니다.(本です。)</span>
            </div>
            <div class="voiceLinkBox">
              <a href="javascript:playItem('sample-2.mp3')">
                <img alt="音声を再生" src="/pixel.svg">
              </a>
              <a href="/sound/sample-2.mp3">
                <img alt="音声をダウンロード" src="/pixel.svg">
              </a>
            </div>
          </div>
          <div class="instance gra_dl_box">
            <div class="instTxtBlk">
              <span class="instance_t">(3)중복입니다.(重複です。)</span>
            </div>
            <div class="voiceLinkBox">
              <a href="javascript:playItem('sample-3a.mp3')">
                <img alt="音声を再生" src="/pixel.svg">
              </a>
              <a href="/sound/sample-3a.mp3">
                <img alt="音声をダウンロード" src="/pixel.svg">
              </a>
            </div>
          </div>
          <div class="instance gra_dl_box">
            <div class="instTxtBlk">
              <span class="instance_t">(3)중복입니다.(重複です。)</span>
            </div>
            <div class="voiceLinkBox">
              <a href="javascript:playItem('sample-3b.mp3')">
                <img alt="音声を再生" src="/pixel.svg">
              </a>
              <a href="/sound/sample-3b.mp3">
                <img alt="音声をダウンロード" src="/pixel.svg">
              </a>
            </div>
          </div>
          <div id="audio-extra" style="display:none; min-height:240px">
            音声操作後に表示する高さ監視用要素
          </div>
        </section>
      </div>
    `;
  }

  return `
    <div class="gra_in_content" id="exercises_box">
      <div id="ques_view_0" class="gra_ques_sec">
        <label>答え <input type="text"></label>
        <a href="javascript:document.getElementById('answerBlock0').style.display='block'">
          Check Answer
        </a>
        <div class="answerBlock" id="answerBlock0" style="display:none">
          <h3>正解</h3>
          <p>한국어입니다.</p>
        </div>
      </div>
    </div>
  `;
}

function fixture(pageType) {
  return `<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8">
        <title>朝鮮語 文法 03.01.1：${pageType}</title>
        <script>
          window.addEventListener("error", function (event) {
            const current =
              Number.parseInt(document.documentElement.dataset.pageErrorCount || "0", 10);
            document.documentElement.dataset.pageErrorCount = String(current + 1);
            document.documentElement.dataset.lastPageError = event.message || "unknown";
          });
          window.playItem = function (source) {
            document.documentElement.dataset.lastPlayed = source;
            const extra = document.getElementById("audio-extra");
            if (extra) extra.style.display = "block";
          };
        </script>
      </head>
      <body>
        <div id="container">
          <header><h1>東京外国語大学言語モジュール</h1></header>
          <nav id="t_path4">
            <a href="/">東外大言語モジュールTop</a> &gt;
            <a href="/mt/ko/">朝鮮語</a> &gt;
            <a href="/mt/ko/gmod/courses/c03/">標準コース（併記式）</a> &gt;
            <a href="/mt/ko/gmod/courses/c03/lesson01/">Lesson01</a>
          </nav>
          <section class="clearfix" id="content_box">
            ${navigation(pageType)}
            <h2 class="gra_in_title">
              Step1<span id="step_title"> : 001 : 입니다</span>
            </h2>
            ${pageContent(pageType)}
          </section>
          <footer id="footer">Copyright 東京外国語大学</footer>
        </div>
        <script src="/test-userscript.js"></script>
      </body>
    </html>`;
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);

  if (requestUrl.pathname === "/test-userscript.js") {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(userscript);
    return;
  }

  if (requestUrl.pathname === "/pixel.svg") {
    response.writeHead(200, {
      "content-type": "image/svg+xml",
      "cache-control": "no-store",
    });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#315f86"/></svg>',
    );
    return;
  }

  if (requestUrl.pathname.startsWith("/sound/")) {
    const fakeMp3 = Buffer.from([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    response.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": String(fakeMp3.byteLength),
      "cache-control": "no-store",
    });
    response.end(fakeMp3);
    return;
  }

  const pageType = Object.entries(routes).find(
    ([type, route]) => type !== "next" && route === requestUrl.pathname,
  )?.[0];

  if (pageType) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(fixture(pageType));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found");
});

server.listen(port, host, () => {
  console.log(`TUFS smoke fixture: http://${host}:${port}${routes.card}`);
});

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
