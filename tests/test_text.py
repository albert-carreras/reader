"""Regression cases for 'any page': what the narrator must say for tricky book text.

Run: uv run pytest -q
"""
import pytest

from reader.book import Block, Chapter
from reader.segment import units
from reader.textnorm import speak

ES = [
    ("En el siglo XIX, Felipe II y Carlos III reinaron.", "En el siglo diecinueve, Felipe segundo y Carlos tercero reinaron."),
    ("Llegó el 3 de mayo de 1808 a las 7:30.", "Llegó el tres de mayo de mil ochocientos ocho a las siete y media."),
    ("El Sr. Villalba y D. Ramón.", "El señor Villalba y Don Ramón."),
    ("Era el 1.º de la clase y la 2.ª en llegar.", "Era el primero de la clase y la segunda en llegar."),
    ("La guerra (1914-1918) fue larga.", "La guerra, mil novecientos catorce a mil novecientos dieciocho, fue larga."),
    ("Ud. y Uds. lo sabían.", "usted y ustedes lo sabían."),
    ("Leyó el capítulo IV.", "Leyó el capítulo cuatro."),
    ("Iba á pesar de todo, é hizo lo que pudo.", "Iba a pesar de todo, e hizo lo que pudo."),
    ("Había recorrido 1.200 kilómetros.", "Había recorrido mil doscientos kilómetros."),
]
EN = [
    ("On May 3rd, 1808, at 7:30 p.m.", "On may third, eighteen oh eight, at seven thirty PM"),
    ("Henry VIII met Louis XIV.", "Henry the eighth met Louis the fourteenth."),
    ("Mr. and Mrs. Smith met Dr. Jones.", "mister and misses Smith met doctor Jones."),
    ("World War II ended in 1945.", "World War two ended in nineteen forty five."),
    ("Read Chapter XII tonight.", "Read Chapter twelve tonight."),
    ("It was—as she knew—too late.", "It was, as she knew, too late."),
    ("The book I wanted was gone.", "The book I wanted was gone."),
    ("In Part I of the letter I wrote, I said no.", "In Part one of the letter I wrote, I said no."),
    ("Read volume II, then volume I.", "Read volume two, then volume one."),
    ("Call 555-1234.", "Call five five five, one two three four."),
    ("The war (1914-1918) and pages 111-222.", "The war, nineteen fourteen to nineteen eighteen, and pages one hundred and eleven to two hundred and twenty two."),
]
HEADINGS = [
    ("I. Perdido.", "es", "Capítulo uno. Perdido."),
    ("IV", "en", "Chapter four"),
    ("Stave I. Marley’s Ghost", "en", "Stave one. Marley's Ghost"),
    ("CAPÍTULO PRIMERO", "es", "Capítulo primero"),
]


@pytest.mark.parametrize("text,want", ES)
def test_es(text, want):
    assert speak(text, "es") == want


@pytest.mark.parametrize("text,want", EN)
def test_en(text, want):
    assert speak(text, "en") == want


@pytest.mark.parametrize("text,lang,want", HEADINGS)
def test_headings(text, lang, want):
    assert speak(text, lang, heading=True).replace("’", "'") == want


def _units(text, lang):
    return [(u.role, u.kind, u.spoken) for u in units(Chapter(1, "t", "t", "body", [Block("para", text)]), lang)]


def test_raya_dialogue_unspaced():
    got = _units("—No puedo equivocarme—murmuró.—Me dijeron que sí.", "es")
    assert [(r, t) for r, _, t in got] == [("speech", "No puedo equivocarme, murmuró."), ("speech", "Me dijeron que sí.")]


def test_raya_dialogue_spaced():
    got = _units("—¿Vienes? —preguntó ella—. No tardes.", "es")
    assert [(r, t) for r, _, t in got] == [("speech", "¿Vienes? preguntó ella."), ("speech", "No tardes.")]


def test_wh_vs_yesno():
    kinds = [k for _, k, _ in _units("—¿En dónde estás? ¿Pero qué más da? ¿Te acobardarás ahora?", "es")]
    assert kinds == ["wh", "wh", "yesno"]
    kinds = [k for _, k, _ in _units("“What right have you to be merry? Is there another one?”", "en")]
    assert kinds == ["wh", "yesno"]


def test_quote_tag_keeps_sentence_open():
    got = _units("“And what is the use of a book,” thought Alice “without pictures or conversations?”", "en")
    assert got == [("speech", "yesno", "And what is the use of a book, thought Alice, without pictures or conversations?")]


def test_quoted_mention_is_not_dialogue():
    got = _units('The word, “sack,” was on page 345.', "en")
    assert [r for r, *_ in got] == ["narration"] and got[0][2].startswith("The word, sack, was on page")
    got = _units('“I’m sorry,” he said, “it’s just that…”', "en")
    assert [(r, t) for r, _, t in got] == [("speech", "I'm sorry, he said, it's just that...")]
    got = _units('“What does it mean?” Biscuit looked thoughtful. “I’m not sure.”', "en")
    assert len(got) == 3                                      # an action beat is its own sentence


def test_small_caps_opening():
    assert speak("ALTHOUGH I HAVE LOVED MANY, there has been only one.", "en").startswith("Although I have loved many, there")
    assert speak("He works for the BBC in London.", "en") == "He works for the BBC in London."


def test_hard_wrapped_prose_is_not_verse():
    from reader.book import _looks_like_verse, _unwrap
    prose = "ALTHOUGH I HAVE\nLOVED MANY, there has been only one genuine love in my\nnear-eternally stretched life – Rachel who fell to the bottom of\nthe library without me. Did I know her only for so short a time?"
    assert not _looks_like_verse(prose)
    assert _unwrap(prose).startswith("ALTHOUGH I HAVE LOVED MANY, there has been only one genuine love in my near-eternally")
    assert _unwrap("our con-\nsciousness ever after") == "our consciousness ever after"
    poem = "How doth the little crocodile\nImprove his shining tail,\nAnd pour the waters of the Nile\nOn every golden scale!"
    assert _looks_like_verse(poem)
