"""Rules that decide extra work: a second take for a wrong ending, side lanes holding for the listener."""
from reader.render import wrong_ending
from reader.worker import Worker


def test_second_take_only_for_wrong_endings():
    assert wrong_ending("yesno", {"final_delta": 0.2})          # a yes/no question that doesn't rise
    assert not wrong_ending("yesno", {"final_delta": 3.4})
    assert wrong_ending("statement", {"final_delta": 1.8})      # a statement that rises
    assert not wrong_ending("statement", {"final_delta": -2.0})
    assert not wrong_ending("exclaim", {"final_delta": 6.0})    # no rule for this kind
    assert not wrong_ending("yesno", None)                      # no pitch found: nothing to judge


CHAPTERS = {3: [dict(u0=0, u1=10, est=30), dict(u0=10, u1=20, est=30), dict(u0=20, u1=30, est=30), dict(u0=30, u1=40, est=30)],
            4: [dict(u0=0, u1=10, est=30), dict(u0=10, u1=20, est=30)]}


def _worker(monkeypatch, chapter, segment, focus_unit, state="rendering"):
    from reader import library as lib
    monkeypatch.setattr(lib, "meta", lambda b: dict(chapters=[dict(index=k, include=True, n_segments=len(v)) for k, v in CHAPTERS.items()]))
    monkeypatch.setattr(lib, "chapter", lambda b, i: dict(segments=CHAPTERS[i]))
    w = Worker()
    w.status.update(state=state, job=dict(book="b", chapter=chapter, segment=segment))
    w.focus = ("b", 3, focus_unit)
    return w


def test_side_lanes_hold_while_the_listener_waits(monkeypatch):
    assert _worker(monkeypatch, 3, 1, 12).listener_waiting()          # lane 0 is on the piece being listened to
    assert _worker(monkeypatch, 3, 2, 12).listener_waiting()          # ... or the next one
    assert not _worker(monkeypatch, 3, 3, 12).listener_waiting()      # two pieces ahead: no hurry
    assert not _worker(monkeypatch, 3, 0, 12).listener_waiting()      # lane 0 filling in behind the listener
    assert _worker(monkeypatch, 4, 0, 35).listener_waiting()          # the next chapter's start, from the last piece
    assert not _worker(monkeypatch, 4, 0, 12).listener_waiting()      # ... but not from further back
    assert not _worker(monkeypatch, 3, 1, 12, state="paused").listener_waiting()
    w = _worker(monkeypatch, 3, 1, 12)
    w.focus = ("other", 3, 12)                                       # listening to another book
    assert not w.listener_waiting()


def test_take_preference():
    from reader.render import rank
    from reader.segment import Unit
    q = Unit(id="1", block=0, start=0, end=3, text="¿Sí?", spoken="Sí?", role="speech", kind="yesno", pause=0.3)
    rises = dict(f={"final_delta": 3.0}, score=0.2, parts={})
    falls = dict(f={"final_delta": 0.2}, score=1.5, parts={})
    pitchless = dict(f=None, score=-5.0, parts={})
    jumps = dict(f={"final_delta": 3.0}, score=-1.0, parts={"register": -1.8})     # right ending, wrong register
    order = sorted([pitchless, falls, rises, jumps], key=lambda t: rank(q, t))
    assert order == [rises, falls, jumps, pitchless]
