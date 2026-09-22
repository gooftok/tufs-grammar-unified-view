"""公式一覧から各言語の先頭教材を少数取得し、構造だけを記録する。"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen


INDEX = "https://www.coelang.tufs.ac.jp/mt/index_g.html"


class Page(HTMLParser):
    def __init__(self, url, html):
        super().__init__()
        self.url = url
        self.links = []
        self.tab_links = []
        self.tab_depth = 0
        self.ids = set()
        self.classes = set()
        self.scripts = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "gra_in_menu_container" in attrs.get("class", "").split():
            self.tab_depth = 1
        elif self.tab_depth and tag not in {"img", "br", "hr", "input", "meta", "link"}:
            self.tab_depth += 1
        if "id" in attrs:
            self.ids.add(attrs["id"])
        self.classes.update(attrs.get("class", "").split())
        if tag == "a" and attrs.get("href"):
            self.links.append(urljoin(self.url, attrs["href"]))
            if self.tab_depth:
                self.tab_links.append(urljoin(self.url, attrs["href"]))
        if tag == "script" and attrs.get("src"):
            self.scripts.append(urljoin(self.url, attrs["src"]))

    def handle_endtag(self, tag):
        if self.tab_depth:
            self.tab_depth -= 1


def fetch(url):
    with urlopen(url, timeout=25) as response:
        html = response.read().decode("utf-8")
        return Page(response.url, html)


def describe(page):
    return {
        "url": page.url,
        "ids": sorted(page.ids),
        "classes": sorted(page.classes),
        "page_links": list(dict.fromkeys(link for link in page.tab_links
            if re.search(r"/(card|explanation|instances|exercises)/", link))),
        "audio_links": list(dict.fromkeys(link for link in page.links
            if link.startswith("javascript:") or ".mp3" in link)),
        "scripts": page.scripts,
    }


def probe(root):
    result = {"root": root, "trail": [], "pages": []}
    try:
        page = fetch(root)
        prefix = urlparse(root).path.rstrip("/") + "/"
        visited = set()
        # 一覧→コース→Lesson→Step の実リンクだけを最大5段たどる。
        for _ in range(5):
            visited.add(page.url)
            result["trail"].append(page.url)
            if re.search(r"/(card|explanation|instances|exercises)/[^/]+\.html", page.url):
                break
            candidates = [link for link in page.links
                if urlparse(link).netloc == urlparse(root).netloc
                and urlparse(link).path.startswith(prefix + "courses/")
                and link not in visited]
            if not candidates:
                result["status"] = "course_step_not_found"
                result["pages"].append(describe(page))
                return result
            candidates.sort(key=lambda link: (
                bool(re.search(r"/step[^/]+/(card|explanation|instances|exercises)/", link)),
                bool(re.search(r"/lesson[^/]+/", link)),
            ), reverse=True)
            page = fetch(candidates[0])
        result["pages"].append(describe(page))
        step_root = re.sub(r"/(card|explanation|instances|exercises)/.*", "/", page.url)
        if not re.search(r"/(card|explanation|instances|exercises)/[^/]+\.html$", page.url):
            result["status"] = "course_step_not_found"
            return result
        links = list(dict.fromkeys(link for link in page.tab_links
            if link.startswith(step_root)
            and re.search(r"/(card|explanation|instances|exercises)/[^/]+\.html$", link)))
        for link in links:
            if link != page.url and len(result["pages"]) < 4:
                result["pages"].append(describe(fetch(link)))
        result["status"] = "sampled"
    except Exception as error:
        result["status"] = "error"
        result["error"] = str(error)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="新規の検証記録JSON")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("既存の記録は上書きしません。別の出力先を指定してください。")
    roots = list(dict.fromkeys(link for link in fetch(INDEX).links
        if re.fullmatch(r"https://www\.coelang\.tufs\.ac\.jp/mt/[a-z-]+/gmod/?", link)))
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(probe, roots))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "index": INDEX, "scope": "各言語の先頭コース・先頭Step。全教材の動作保証ではない。",
        "results": results,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for result in results:
        print(result["root"], result["status"], [p["url"] for p in result["pages"]])
