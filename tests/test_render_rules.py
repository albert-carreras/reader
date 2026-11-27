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


def _worker(job_segment, focus_unit, state="rendering"):
    w = Worker()
    w._lane0_segs = [dict(u0=0, u1=10), dict(u0=10, u1=20), dict(u0=20, u1=30), dict(u0=30, u1=40)]
    w.status.update(state=state, job=dict(book="b", chapter=3, segment=job_segment))
    w.focus = ("b", 3, focus_unit)
    return w


def test_side_lanes_hold_while_the_listener_waits():
    assert _worker(1, 12).listener_waiting()          # lane 0 is on the piece being listened to
    assert _worker(2, 12).listener_waiting()          # ... or the next one
    assert not _worker(3, 12).listener_waiting()      # two pieces ahead: no hurry
    assert not _worker(0, 12).listener_waiting()      # lane 0 filling in behind the listener
    assert not _worker(1, 12, state="paused").listener_waiting()
    w = _worker(1, 12)
    w.focus = ("b", 4, 12)                            # listening to another chapter
    assert not w.listener_waiting()
