"""reader web app: library, read-along player, render status. One process (`python -m reader.server`).

Auth: requests arriving through the Cloudflare edge (X-Forwarded-Host set by the Worker) must carry a valid
Cloudflare Access JWT for READER_ACCESS_AUD. Until that is configured, every remote request is refused, so the
library is never public, even if the custom domain exists before the Access application does.
Direct loopback requests (on the laptop itself) are allowed.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import shutil
import threading
import time
import urllib.request
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import library as lib
from .engine import DEFAULT_VOICE
from .worker import Worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
WEB = Path(__file__).parent / "web"
ACCESS_TEAM = os.environ.get("READER_ACCESS_TEAM", "")       # e.g. bertini.cloudflareaccess.com
ACCESS_AUD = os.environ.get("READER_ACCESS_AUD", "")         # Application Audience (AUD) tag; optional but recommended
PUBLIC_HOSTS = {h for h in os.environ.get("READER_PUBLIC_HOSTS", "reader.bored.cat").split(",") if h}

VOICES = {
    "es": ["Alba", "Noa", "Candela", "Celia", "Alicia", "Nerea", "Lucía-Sol", "Marcos", "Borja", "Iker", "Nuno", "Izan",
           "Guillermo", "Rebeca", "Regina", "Danae", "Azucena", "Jimena", "Ximena", "Lalo", "Aldo", "Yael", "Ulises", "Leonel", "Nico"],
    "en": ["Easton", "Micah", "Trevor", "Russell", "Preston", "Miles", "Zoey", "Juniper", "Everly", "Harper", "Hadley", "Delia",
           "Maeve", "Freya", "Pippa", "Elodie-Rose", "Imogen", "Lottie", "Bryony", "Alfie", "Hugh", "Edwin", "Spencer", "Toby", "Teddy"],
}

app = FastAPI(title="reader", docs_url=None, redoc_url=None, openapi_url=None)
worker = Worker()


@app.on_event("startup")
def _start():
    lib.BOOKS.mkdir(parents=True, exist_ok=True)
    lib.CACHE.mkdir(parents=True, exist_ok=True)
    lib.upgrade_all()
    worker.start()


# ---------------------------------------------------------------- auth

@functools.lru_cache(maxsize=1)
def _jwks_client():
    import jwt
    return jwt.PyJWKClient(f"https://{ACCESS_TEAM}/cdn-cgi/access/certs", cache_keys=True, lifespan=3600)


def _access_ok(request: Request) -> tuple[bool, str]:
    if not ACCESS_TEAM:
        return False, "Cloudflare Access is not configured for reader yet (READER_ACCESS_TEAM)."
    token = request.headers.get("cf-access-jwt-assertion") or request.cookies.get("CF_Authorization")
    if not token:
        return False, "Missing Cloudflare Access token."
    try:
        import jwt
        key = _jwks_client().get_signing_key_from_jwt(token).key
        jwt.decode(token, key, algorithms=["RS256"], issuer=f"https://{ACCESS_TEAM}",
                   audience=ACCESS_AUD or None, options={"verify_aud": bool(ACCESS_AUD)})
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, f"Invalid Cloudflare Access token ({type(e).__name__})."


@app.middleware("http")
async def guard(request: Request, call_next):
    fwd_host = request.headers.get("x-forwarded-host")
    client = request.client.host if request.client else ""
    if fwd_host is not None or client not in ("127.0.0.1", "::1"):
        if fwd_host not in PUBLIC_HOSTS:
            return JSONResponse({"error": "not found"}, status_code=404)
        if request.url.path != "/healthz":
            ok, why = _access_ok(request)
            if not ok:
                return HTMLResponse(f"<!doctype html><meta charset=utf-8><title>reader · locked</title>"
                                    f"<body style='font:16px system-ui;margin:4rem auto;max-width:36rem'>"
                                    f"<h1>Locked</h1><p>{why}</p></body>", status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("cache-control", "private, no-store" if request.url.path.startswith("/api") else "private, max-age=60")
    return resp


# ---------------------------------------------------------------- pages

@app.get("/healthz")
def healthz():
    return {"ok": True, "worker": worker.status["state"]}


@app.get("/", response_class=HTMLResponse)
def index():
    return FileResponse(WEB / "index.html", headers={"cache-control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(WEB / "manifest.webmanifest", media_type="application/manifest+json", headers={"cache-control": "no-cache"})


@app.get("/sw.js")
def service_worker():
    return FileResponse(WEB / "sw.js", media_type="text/javascript", headers={"cache-control": "no-cache", "service-worker-allowed": "/"})


app.mount("/static", StaticFiles(directory=WEB), name="static")


# ---------------------------------------------------------------- api

def _book_or_404(book_id: str) -> dict:
    try:
        return lib.meta(book_id)
    except KeyError:
        raise HTTPException(404, "no such book")


@app.get("/api/status")
def status():
    st = dict(worker=worker.status, focus=worker.focus, settings=lib.settings())
    job = worker.status.get("job")
    if job:
        q = next((b for b in worker.queue() if b["id"] == job["book"]), None)
        if q:
            st["book"] = q
    return st


@app.get("/api/system")
def system():
    return dict(worker=worker.status, settings=lib.settings(), queue=worker.queue())


class SystemIn(BaseModel):
    paused: bool | None = None
    threads: int | None = None


@app.put("/api/system")
def put_system(body: SystemIn):
    if body.threads is not None and body.threads not in (1, 2, 4, 6, 8, 12):
        raise HTTPException(400, "threads must be 1, 2, 4, 6, 8 or 12")
    s = lib.set_settings(paused=body.paused, threads=body.threads)
    worker.wake.set()
    return s


@app.get("/api/storage")
def storage():
    return lib.storage()


@app.post("/api/storage/clean")
def clean_storage():
    return {"freed": lib.clean_cache()}


@app.get("/api/books")
def books():
    return lib.list_books()


IMPORTS: dict[str, dict] = {}


def _import_job(job_id: str, path: Path, name: str):
    try:
        IMPORTS[job_id]["book"] = lib.import_epub(path, name)
        IMPORTS[job_id]["state"] = "done"
    except Exception as e:  # noqa: BLE001
        IMPORTS[job_id].update(state="error", error=f"could not read this EPUB: {e}")
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/books")
def upload(file: UploadFile = File(...)):
    """Imports run in the background (a long book takes a while); poll /api/imports/{job}."""
    if not (file.filename or "").lower().endswith(".epub"):
        raise HTTPException(400, "only .epub files")
    inbox = lib.DATA / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    job_id = os.urandom(6).hex()
    path = inbox / f"{job_id}.epub"
    with path.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    IMPORTS[job_id] = dict(id=job_id, name=file.filename, state="importing", started=time.time())
    threading.Thread(target=_import_job, args=(job_id, path, file.filename or ""), daemon=True).start()
    return IMPORTS[job_id]


@app.get("/api/imports/{job_id}")
def import_status(job_id: str):
    if job_id not in IMPORTS:
        raise HTTPException(404)
    return IMPORTS[job_id]


@app.get("/api/books/{book_id}")
def get_book(book_id: str):
    m = _book_or_404(book_id)
    for c in m["chapters"]:
        st = lib.chapter_status(book_id, c["index"], c["n_segments"])
        c["ready"] = sum(st)
        c["full"] = lib.chapter_file_ready(book_id, c["index"])        # downloadable for offline
        c["bytes"] = (lib.audio_dir(book_id, c["index"]) / "full.m4a").stat().st_size if c["full"] else 0
    m["position"] = lib.position(book_id)
    m["progress"] = lib.progress(m)
    m["voices"] = VOICES.get(m["lang"], VOICES["en"])
    m["langs"] = lib.LANGS
    q = next((b for b in worker.queue() if b["id"] == book_id), None)
    m["eta"] = q and q["eta"]
    m["rendering_now"] = (worker.status.get("job") or {}).get("book") == book_id
    return m


class BookIn(BaseModel):
    voice: str | None = None
    lang: str | None = None
    render: bool | None = None


@app.patch("/api/books/{book_id}")
def patch_book(book_id: str, body: BookIn):
    m = _book_or_404(book_id)
    if body.lang is not None:
        if body.lang not in lib.LANGS:
            raise HTTPException(400, "unknown language")
        m = lib.set_lang(book_id, body.lang)
    if body.voice is not None:
        if body.voice not in VOICES.get(m["lang"], []):
            raise HTTPException(400, "unknown voice")
        m = lib.set_voice(book_id, body.voice)
    if body.render is not None:
        m = lib.set_render(book_id, body.render)
    worker.wake.set()
    return m


@app.delete("/api/books/{book_id}/audio")
def clear_book_audio(book_id: str):
    _book_or_404(book_id)
    return {"freed": lib.clear_audio(book_id)}


@app.delete("/api/books/{book_id}")
def delete_book(book_id: str):
    _book_or_404(book_id)
    lib.delete(book_id)
    return {"ok": True}


@app.get("/api/books/{book_id}/cover")
def cover(book_id: str):
    _book_or_404(book_id)
    p = lib.cover_path(book_id)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, headers={"cache-control": "private, max-age=86400"})


@app.get("/api/books/{book_id}/chapters/{n}")
def get_chapter(book_id: str, n: int):
    _book_or_404(book_id)
    try:
        c = lib.chapter(book_id, n)
    except KeyError:
        raise HTTPException(404)
    st = lib.chapter_status(book_id, n, len(c["segments"]))
    for seg, ready in zip(c["segments"], st):
        seg["ready"] = ready
    c["full"] = lib.chapter_file_ready(book_id, n)
    c["units"] = [dict(i=i, block=u["block"], start=u["start"], end=u["end"], role=u["role"]) for i, u in enumerate(c["units"])]
    return c


@app.get("/api/books/{book_id}/chapters/{n}/segments/{s}")
def get_segment(book_id: str, n: int, s: int):
    _book_or_404(book_id)
    p = lib.audio_dir(book_id, n) / f"{int(s)}.json"
    if not p.exists():
        raise HTTPException(404, "not rendered yet")
    return JSONResponse(json.loads(p.read_text()))


@app.get("/api/books/{book_id}/chapters/{n}/timeline")
def get_chapter_timeline(book_id: str, n: int):
    _book_or_404(book_id)
    p = lib.audio_dir(book_id, n) / "full.json"
    if not p.exists():
        raise HTTPException(404, "chapter not complete yet")
    return JSONResponse(json.loads(p.read_text()))


@app.get("/api/books/{book_id}/chapter-audio/{n}.m4a")
def get_chapter_audio(book_id: str, n: int):
    _book_or_404(book_id)
    p = lib.audio_dir(book_id, n) / "full.m4a"
    if not p.exists():
        raise HTTPException(404, "chapter not complete yet")
    return FileResponse(p, media_type="audio/mp4", headers={"cache-control": "private, max-age=31536000, immutable"})


@app.get("/api/books/{book_id}/audio/{n}/{s}.m4a")
def get_audio(book_id: str, n: int, s: int):
    _book_or_404(book_id)
    p = lib.audio_dir(book_id, n) / f"{int(s)}.m4a"
    if not p.exists():
        raise HTTPException(404, "not rendered yet")
    return FileResponse(p, media_type="audio/mp4", headers={"cache-control": "private, max-age=31536000, immutable"})


class FocusIn(BaseModel):
    chapter: int
    unit: int = 0


@app.post("/api/books/{book_id}/focus")
def focus(book_id: str, body: FocusIn):
    _book_or_404(book_id)
    worker.set_focus(book_id, body.chapter, body.unit)
    return dict(ok=True, worker=worker.status)


class PositionIn(BaseModel):
    chapter: int
    unit: int
    t: float = 0.0           # seconds into the chapter
    at: float | None = None  # client timestamp (ms) of this position, for offline catch-up


@app.put("/api/books/{book_id}/position")
def put_position(book_id: str, body: PositionIn):
    _book_or_404(book_id)
    worker.set_focus(book_id, body.chapter, body.unit)
    cur = lib.position(book_id) or {}
    if body.at and cur.get("updated") and body.at / 1000 < cur["updated"] - 1:
        return cur      # an older offline write arriving late: keep the newer position
    return lib.set_position(book_id, body.chapter, body.unit, body.t)


def main():
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("READER_PORT", "8130")), log_level="info",
                proxy_headers=False, access_log=False)


if __name__ == "__main__":
    main()
