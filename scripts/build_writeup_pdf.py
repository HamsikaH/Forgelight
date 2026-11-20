#!/usr/bin/env python3
"""Render docs/WRITEUP.md to docs/WRITEUP.pdf (A4) with headless Chrome and report the page count.

Usage: python3 scripts/build_writeup_pdf.py [source.md] [out.pdf]
Needs the `markdown` and `pypdf` packages and Google Chrome (or Chromium/Edge).
The Forge-a-thon write-up must be 1 to 3 pages.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

try:
    import markdown
    import pypdf
except ImportError:
    sys.exit("Missing packages. Run: python3 -m venv .venv && .venv/bin/pip install markdown pypdf")

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

CSS = """
@page { size: A4; margin: 15mm 16mm; }
html, body { margin: 0; padding: 0; }
body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 9.6pt; line-height: 1.3; color: #111; }
h1 { font-size: 15pt; margin: 0 0 2pt; }
h1 + p { color: #444; margin-bottom: 6pt; }
h2 { font-size: 11.5pt; margin: 8pt 0 3pt; padding-bottom: 1pt; border-bottom: 1px solid #ccc; }
p { margin: 0 0 4pt; }
ul, ol { margin: 0 0 4pt 15pt; padding: 0; }
li { margin: 0 0 1.5pt; }
table { border-collapse: collapse; width: 100%; margin: 2pt 0 5pt; font-size: 9pt; }
th, td { border: 1px solid #bbb; padding: 1.5pt 4pt; vertical-align: top; text-align: left; }
th { background: #f2f2f2; }
code { font-family: Menlo, Consolas, monospace; font-size: 8.6pt; background: #f4f4f4; padding: 0 2px; border-radius: 2px; }
"""


def main() -> None:
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "WRITEUP.md"
    out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "docs" / "WRITEUP.pdf"
    body = markdown.markdown(src.read_text(encoding="utf-8"), extensions=["tables"])
    with tempfile.TemporaryDirectory() as tmp:
        html_path = pathlib.Path(tmp) / "writeup.html"
        html_path.write_text(
            f"<!doctype html><html><head><meta charset='utf-8'><title>Forgelight write-up</title>"
            f"<style>{CSS}</style></head><body>{body}</body></html>",
            encoding="utf-8",
        )
        chrome = next((c for c in CHROME_CANDIDATES if os.path.exists(c)), None)
        if not chrome:
            sys.exit("No Chrome/Chromium found for PDF export.")
        subprocess.run(
            [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
             f"--user-data-dir={tmp}/profile", "--no-pdf-header-footer", f"--print-to-pdf={out}", html_path.as_uri()],
            check=True, timeout=180, capture_output=True,
        )
    pages = len(pypdf.PdfReader(str(out)).pages)
    print(f"Wrote {out} ({pages} page{'s' if pages != 1 else ''})")
    if pages > 3:
        sys.exit("Too long: the write-up must be 1 to 3 pages.")


if __name__ == "__main__":
    main()
