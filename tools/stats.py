"""Katalogdaki uygulamaların GitHub Releases indirme sayılarını toplar → stats.json.

    GITHUB_TOKEN=... python tools/stats.py catalog.json _site/stats.json

Admin paneli iş akışı bunu birkaç saatte bir çalıştırıp GitHub Pages'e koyar; CLD Hub
"Popüler" rafı ve detay sayfasındaki indirme sayısı için buradan okur. Sunucu gerekmez.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests


def release_downloads(session: requests.Session, repo: str) -> int | None:
    total, url = 0, f"https://api.github.com/repos/{repo}/releases?per_page=100"
    while url:
        resp = session.get(url, timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        total += sum(asset.get("download_count", 0)
                     for release in resp.json() for asset in release.get("assets", []))
        url = resp.links.get("next", {}).get("url")
    return total


def main(catalog_path: str, out_path: str):
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    session = requests.Session()
    session.headers["Accept"] = "application/vnd.github+json"
    if os.environ.get("GITHUB_TOKEN"):
        session.headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"

    downloads = {}
    for app in catalog.get("apps", []):
        repo = app.get("github_repo")
        if not (repo and app.get("id")):
            continue
        try:
            count = release_downloads(session, repo)
        except requests.RequestException as ex:
            print(f"{repo}: {ex}", file=sys.stderr)
            continue
        if count is not None:
            downloads[app["id"]] = count

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "downloads": downloads,
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(downloads))


if __name__ == "__main__":
    main(*sys.argv[1:3])
