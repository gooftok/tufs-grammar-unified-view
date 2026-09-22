"""各区分の末尾から教材のあるコースを選び、中間・末尾Lessonの最終Stepを抽出する。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import runpy

probe = runpy.run_path(str(Path(__file__).with_name("probe-site.py")))
fetch, describe, INDEX = (probe[name] for name in ["fetch", "describe", "INDEX"])


def sample(root):
    results = []
    try:
        start = fetch(root)
        courses = list(dict.fromkeys(link for link in start.links
            if re.fullmatch(re.escape(root.rstrip("/")) + r"/courses/[^/]+/", link)))
        if not courses:
            raise ValueError("コース一覧が見つかりません。")
        lessons = []
        for course_url in reversed(courses):
            course = fetch(course_url)
            lessons = list(dict.fromkeys(link for link in course.links
                if re.fullmatch(re.escape(course.url.rstrip("/")) + r"/lesson[^/]+/", link)))
            if lessons:
                break
        if not lessons:
            raise ValueError("Lesson一覧が見つかりません。")
        for lesson_url in dict.fromkeys([lessons[len(lessons) // 2], lessons[-1]]):
            lesson = fetch(lesson_url)
            steps = list(dict.fromkeys(link for link in lesson.links
                if re.fullmatch(re.escape(lesson_url) + r"step[^/]+/card/[^/]+\.html", link)))
            if not steps:
                raise ValueError(f"Step一覧が見つかりません: {lesson_url}")
            page = fetch(steps[-1])
            results.append({"root": root, "status": "sampled", "pages": [describe(page)]})
    except Exception as error:
        results.append({"root": root, "status": "error", "error": str(error)})
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("出力先が存在します。新しいファイル名を指定してください。")
    roots = list(dict.fromkeys(link for link in fetch(INDEX).links
        if re.fullmatch(r"https://www\.coelang\.tufs\.ac\.jp/mt/[a-z-]+/gmod/?", link)))
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = [result for group in executor.map(sample, roots) for result in group]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"checked_at": datetime.now(timezone.utc).isoformat(),
        "scope": __doc__, "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("取得", sum(item["status"] == "sampled" for item in results))
    for item in results:
        if item["status"] != "sampled":
            print(item)
