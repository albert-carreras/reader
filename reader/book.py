"""EPUB -> structured book: chapters -> blocks (heading / para / verse / scene_break ...).

Display text is kept as written; turning it into speech happens later (segment.py, textnorm.py).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

import ebooklib
from bs4 import BeautifulSoup, NavigableString, Tag
from ebooklib import epub

BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "dt", "dd", "figcaption", "td", "th", "div", "blockquote", "header", "hgroup", "section", "article", "aside", "footer", "table", "tr", "tbody", "thead", "ol", "ul", "dl", "figure", "nav", "body"}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
SKIP_TAGS = {"script", "style", "rt", "rp", "nav", "svg", "math", "img", "audio", "video", "object", "iframe"}
NOTE_TYPES = {"footnote", "endnote", "rearnote", "note", "footnotes", "endnotes", "rearnotes"}
VERSE_HINT = re.compile(r"\b(poem|poema|verse|verso|stanza|estrofa|song|lyrics|z3998:poem|z3998:verse|z3998:song)\b", re.I)
SCENE_BREAK = re.compile(r"^[\s*·•⁂§~#=_\-–—.oO0]*$")

# Chapter roles: decided from epub:type, then file name, then title.
SKIP_ROLES = {"praise", "pre-title", "cover", "titlepage", "halftitlepage", "toc", "loi", "lot", "copyright-page", "imprint", "colophon",
              "index", "endnotes", "rearnotes", "footnotes", "bibliography", "landmarks", "page-list", "credits", "about"}
TITLE_ROLES = [
    (r"^(table of )?contents$|^índice( general)?$|^sumario$|^tabla de contenidos?$", "toc"),
    (r"copyright|uncopyright|derechos|créditos|creditos|credits|legal", "copyright-page"),
    (r"^colophon$|^colofón$", "colophon"),
    (r"^imprint$|^about this (e)?book$|^acerca de este libro|^sobre esta edición|^acerca de esta edición", "imprint"),
    (r"^(end)?notes$|^notas( al final)?$", "endnotes"),
    (r"^(title page|cover|portada|cubierta)$", "cover"),
    (r"^(advance )?praise( for .*)?$|^elogios|^reviews$|^acclaim", "praise"),
    (r"^about the authors?$|^sobre (el|la) autora?$|^acerca del? autora?$|^about the translators?$|^sobre (el|la) traductora?$", "about"),
    (r"^index$|^índice alfabético$", "index"),
]
FILE_ROLES = [(r"cover|cubierta|portada", "cover"), (r"(^|[_-])toc|nav|contents|indice", "toc"),
              (r"copyright|imprint|colophon|uncopyright|credits|creditos|about", "copyright-page"),
              (r"^title$|titlepage|title-page|halftitle|^titulo$|portadilla", "titlepage"), (r"endnotes|footnotes|notes", "endnotes")]


@dataclass
class Block:
    kind: str            # heading | para | verse | scene_break | quote | item | caption
    text: str            # display text (verse: lines joined with \n)
    level: int = 0       # heading level
    lines: list[str] = field(default_factory=list)  # verse lines


@dataclass
class Chapter:
    index: int
    title: str
    href: str
    role: str            # body | frontmatter role | backmatter role
    blocks: list[Block]

    @property
    def include(self) -> bool:
        return self.role not in SKIP_ROLES

    @property
    def chars(self) -> int:
        return sum(len(b.text) for b in self.blocks)


@dataclass
class Book:
    title: str
    author: str
    lang: str
    chapters: list[Chapter]
    cover: bytes | None = None
    cover_name: str | None = None


# ---------------------------------------------------------------- text cleanup

_INVISIBLE = dict.fromkeys(map(ord, "­​‌‍⁠﻿"), None)
_SPACES = re.compile(r"[ \t\r\f\v  -   　]+")
_LIGATURES = str.maketrans({"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"})


def clean(s: str) -> str:
    s = unicodedata.normalize("NFC", s).translate(_INVISIBLE).translate(_LIGATURES)
    s = _SPACES.sub(" ", s)
    s = re.sub(r" *\n *", "\n", s)
    return s.strip()


# ---------------------------------------------------------------- DOM -> blocks

def _types(el: Tag) -> str:
    return " ".join(filter(None, [el.get("epub:type", ""), el.get("role", ""),
                                  " ".join(el.get("class", [])) if isinstance(el.get("class"), list) else el.get("class", "")])).lower()


def _is_note_ref(el: Tag) -> bool:
    t = _types(el)
    if "noteref" in t or "doc-noteref" in t:
        return True
    if el.name in ("a", "sup"):
        txt = el.get_text(strip=True)
        href = el.get("href", "") if el.name == "a" else (el.find("a") or {}).get("href", "") if el.find("a") else ""
        if href and ("#" in href) and re.fullmatch(r"[\[\(]?[0-9ivxIVX*†‡§a-z]{1,4}[\]\)]?", txt or ""):
            return True
        if el.name == "sup" and re.fullmatch(r"[\[\(]?[0-9*†‡§]{1,3}[\]\)]?", txt or ""):
            return True
    return False


def _prune(soup: BeautifulSoup) -> None:
    for t in soup(list(SKIP_TAGS)):
        t.decompose()
    for el in soup.find_all(True):
        if el.decomposed:
            continue
        t = _types(el)
        style = (el.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style or el.has_attr("hidden") or "pagenum" in t \
                or re.search(r"\b(hidden|noprint|mw-editsection|reference|mw-ref)\b", t):
            el.decompose()
            continue
        if "pagebreak" in t or "page-break" in t or "doc-pagebreak" in t or any(n in t.split() for n in NOTE_TYPES) \
                or "doc-footnote" in t or "doc-endnote" in t or _is_note_ref(el):
            el.decompose()


def _inline_text(el: Tag) -> str:
    """Text of an element, with <br> turned into newlines."""
    parts = []
    for node in el.descendants:
        if isinstance(node, NavigableString):
            if node.parent and node.parent.name in SKIP_TAGS:
                continue
            parts.append(str(node))
        elif isinstance(node, Tag) and node.name == "br":
            parts.append("\n")
    return clean("".join(parts))


def _in_verse(el: Tag) -> bool:
    for a in [el, *el.parents]:
        if not isinstance(a, Tag) or a.name in ("body", "html"):
            break
        if VERSE_HINT.search(_types(a)):
            return True
    return False


def _walk(el: Tag, out: list[Block], quote: bool = False) -> None:
    has_block_child = el.name not in HEADING_TAGS and any(isinstance(c, Tag) and c.name in BLOCK_TAGS for c in el.children)
    if el.name == "hr":
        out.append(Block("scene_break", ""))
        return
    if has_block_child and el.name not in ("p",):
        # mixed content: loose text directly inside a container still counts as a paragraph
        loose = clean("".join(str(c) for c in el.children if isinstance(c, NavigableString)))
        if loose and re.search(r"\w", loose):
            out.append(Block("para", loose))
        for c in el.children:
            if isinstance(c, Tag):
                if c.name == "hr":
                    out.append(Block("scene_break", ""))
                elif c.name in BLOCK_TAGS:
                    _walk(c, out, quote or c.name == "blockquote")
        return
    text = _inline_text(el)
    if not text:
        return
    if SCENE_BREAK.match(text) and len(text) <= 12:
        out.append(Block("scene_break", text))
    elif el.name in HEADING_TAGS or re.search(r"\b(title|titulo|heading|chapter-title|capitulo)\b", _types(el)):
        level = int(el.name[1]) if el.name in HEADING_TAGS else 3
        out.append(Block("heading", text.replace("\n", " "), level=level))
    elif _in_verse(el) or (text.count("\n") >= 2 and max(map(len, text.split("\n"))) < 70):
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        out.append(Block("verse", "\n".join(lines), lines=lines))
    elif el.name == "li":
        out.append(Block("item", text.replace("\n", " ")))
    elif el.name == "figcaption":
        out.append(Block("caption", text.replace("\n", " ")))
    else:
        out.append(Block("quote" if quote else "para", text.replace("\n", " ")))


def parse_html(html: bytes | str) -> list[Block]:
    soup = BeautifulSoup(html, "lxml")
    _prune(soup)
    body = soup.body or soup
    blocks: list[Block] = []
    _walk(body, blocks)
    # merge consecutive scene breaks, drop leading/trailing ones
    merged: list[Block] = []
    for b in blocks:
        if b.kind == "scene_break" and (not merged or merged[-1].kind == "scene_break"):
            continue
        merged.append(b)
    while merged and merged[-1].kind == "scene_break":
        merged.pop()
    return merged


# ---------------------------------------------------------------- chapter tidy-up

NUMERAL = re.compile(r"^(?:[IVXLCDM]+|\d+)\.?$", re.I)


def _tidy_chapter(blocks: list[Block], book_title: str) -> list[Block]:
    out = list(blocks)
    # running head: the book title repeated at the top of each chapter
    key = lambda s: re.sub(r"\W+", "", s).lower()
    while out and key(out[0].text) == key(book_title) and len(out) > 2:
        out.pop(0)
    # a bare numeral followed by a short title -> one heading ("I" + "Perdido." -> "I. Perdido.")
    if len(out) >= 2 and NUMERAL.match(out[0].text.strip()) and out[1].kind in ("heading", "para") and len(out[1].text) < 90:
        num = out[0].text.strip().rstrip(".")
        out[0:2] = [Block("heading", f"{num}. {out[1].text.strip()}", level=min(out[0].level or 2, out[1].level or 2))]
    elif len(out) >= 2 and out[0].kind == out[1].kind == "heading" and len(out[0].text) + len(out[1].text) < 120:
        out[0:2] = [Block("heading", f"{out[0].text.rstrip('.:')}. {out[1].text}", level=out[0].level)]
    elif out and NUMERAL.match(out[0].text.strip()):
        out[0] = Block("heading", out[0].text.strip(), level=out[0].level or 2)
    return out


def _looks_like_title_page(blocks: list[Block]) -> bool:
    """Short centred lines with no prose: a printed title page, not a chapter."""
    text = [b for b in blocks if b.text]
    if not text or sum(len(b.text) for b in text) > 1500:
        return False
    prose = sum(1 for b in text if len(b.text) > 80 and re.search(r"[.!?…]\s*$", b.text))
    return prose == 0 and len(text) >= 3


# ---------------------------------------------------------------- roles & chapters

def _role(epub_types: str, href: str, title: str) -> str:
    for t in epub_types.split():
        t = t.split(":")[-1]
        if t in SKIP_ROLES:
            return t
        if t in ("dedication", "epigraph", "preface", "foreword", "introduction", "prologue", "epilogue", "afterword", "acknowledgments"):
            return t
    low = title.lower().strip(" .:")
    for pat, role in TITLE_ROLES:
        if re.search(pat, low):
            return role
    name = PurePosixPath(href).stem.lower()
    for pat, role in FILE_ROLES:
        if re.search(pat, name):
            return role
    return "body"


def _flatten_toc(toc):
    for entry in toc:
        if isinstance(entry, tuple):
            section, children = entry
            if getattr(section, "href", None):
                yield section.title, section.href
            yield from _flatten_toc(children)
        elif hasattr(entry, "href"):
            yield entry.title, entry.href


def _lang(code: str | None) -> str:
    code = (code or "en").lower().replace("_", "-")
    return code.split("-")[0]


def load(path: str | Path) -> Book:
    path = Path(path)
    book = epub.read_epub(str(path), options={"ignore_ncx": False})
    meta = lambda k: (book.get_metadata("DC", k) or [[None]])[0][0]
    toc: dict[str, str] = {}
    for title, href in _flatten_toc(book.toc):
        toc.setdefault(PurePosixPath(href.split("#")[0]).name, clean(title or ""))

    chapters: list[Chapter] = []
    for idref, _linear in book.spine:
        item = book.get_item_with_id(idref)
        if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
            continue
        html = item.get_content()
        blocks = parse_html(html)
        if not any(b.text for b in blocks):
            continue
        soup = BeautifulSoup(html, "lxml")
        types = " ".join(_types(t) for t in [soup.body, *(soup.body.find_all(["section", "article"], recursive=True)[:2] if soup.body else [])] if t)
        href = item.get_name()
        toc_title = toc.get(PurePosixPath(href).name)
        blocks = _tidy_chapter(blocks, clean(meta("title") or ""))
        heading = next((b.text for b in blocks if b.kind == "heading"), None)
        title = toc_title or heading
        role = _role(types, href, title or "")
        if role == "body" and _looks_like_title_page(blocks):
            role = "titlepage"
        if title is None and chapters and role == "body":
            chapters[-1].blocks += blocks  # chapter split across files
            continue
        chapters.append(Chapter(len(chapters) + 1, title or f"Section {len(chapters) + 1}", href, role, blocks))

    # untitled leftovers before the title page (blurbs, praise, back-cover copy) are front matter
    tp = next((i for i, c in enumerate(chapters) if c.role in ("titlepage", "halftitlepage")), None)
    for c in chapters[:tp or 0]:
        if c.role == "body" and (c.title.startswith("Section ") or not any(b.kind == "heading" for b in c.blocks)):
            c.role = "pre-title"
    cover, cover_name = None, None
    for it in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover, cover_name = it.get_content(), it.get_name()
    if cover is None:
        for it in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            if "cover" in it.get_name().lower():
                cover, cover_name = it.get_content(), it.get_name()
                break
    return Book(clean(meta("title") or path.stem), clean(meta("creator") or ""), _lang(meta("language")), chapters, cover, cover_name)
