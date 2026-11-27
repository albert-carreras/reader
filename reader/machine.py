"""What the laptop is doing, for the rendering page: CPU (all of it, and this service's share), memory (this
service against its limit, and the machine), swap, temperature, power. Linux only; anything unreadable is None."""
from __future__ import annotations

import os
import time
from pathlib import Path

_last: dict = {}


def _read(p: str | Path) -> str | None:
    try:
        return Path(p).read_text().strip()
    except OSError:
        return None


def _cgroup() -> Path | None:
    """This service's own cgroup (systemd puts the server and its worker processes in it)."""
    line = _read("/proc/self/cgroup")
    if not line or not line.startswith("0::"):
        return None
    p = Path("/sys/fs/cgroup") / line.splitlines()[0][3:].lstrip("/")
    return p if p.exists() else None


def _cpu_sample() -> tuple[float, float, float]:
    """(wall seconds, machine busy core-seconds, this service's core-seconds)."""
    busy = 0.0
    stat = _read("/proc/stat")
    if stat:
        f = [float(x) for x in stat.splitlines()[0].split()[1:]]
        idle = f[3] + (f[4] if len(f) > 4 else 0.0)                    # idle + iowait
        busy = (sum(f[:8]) - idle) / os.sysconf("SC_CLK_TCK")
    mine = 0.0
    cg = _cgroup()
    st = _read(cg / "cpu.stat") if cg else None
    if st:
        mine = next((int(x.split()[1]) / 1e6 for x in st.splitlines() if x.startswith("usage_usec")), 0.0)
    return time.monotonic(), busy, mine


def _meminfo() -> dict[str, int]:
    out = {}
    for line in (_read("/proc/meminfo") or "").splitlines():
        k, v = line.split(":", 1)
        out[k] = int(v.split()[0]) * 1024
    return out


def _limit(cg: Path | None, name: str) -> int | None:
    v = _read(cg / name) if cg else None
    return int(v) if v and v != "max" else None


def _temp() -> float | None:
    """CPU temperature: the package sensor if there is one (k10temp / coretemp), else the ACPI zone."""
    best = None
    for d in Path("/sys/class/hwmon").glob("hwmon*"):
        name = _read(d / "name")
        if name in ("k10temp", "coretemp", "zenpower"):
            t = _read(d / "temp1_input")
            if t:
                return int(t) / 1000
        if name == "acpitz" and best is None:
            t = _read(d / "temp1_input")
            best = int(t) / 1000 if t else None
    return best


def _power() -> dict | None:
    for bat in Path("/sys/class/power_supply").glob("BAT*"):
        cap, status = _read(bat / "capacity"), _read(bat / "status")
        if cap is None:
            continue
        plugged = any(_read(ac / "online") == "1" for ac in Path("/sys/class/power_supply").glob("A*"))
        return dict(battery=int(cap), status=(status or "").lower(), plugged=plugged or status in ("Charging", "Full"))
    return None


def headroom_gb() -> float:
    """Memory this service can still take: what's left under its own limit, or the machine's available memory if
    that is less."""
    avail = _meminfo().get("MemAvailable", 0) / 2**30 or 99.0
    cg = _cgroup()
    cap, cur = _limit(cg, "memory.max"), _limit(cg, "memory.current")
    if cap and cur is not None:
        return min(avail, (cap - cur) / 2**30)
    return avail


def snapshot() -> dict:
    global _last
    now = _cpu_sample()
    prev = _last.get("cpu")
    if not prev or now[0] - prev[0] > 60 or now[0] - prev[0] < 0.2:  # nothing recent to compare with: measure briefly
        prev = now
        time.sleep(0.3)
        now = _cpu_sample()
    _last["cpu"] = now
    cores = os.cpu_count() or 1
    dt = max(now[0] - prev[0], 1e-3)
    cpu = min(100.0, 100 * (now[1] - prev[1]) / dt / cores)
    mine = min(cpu, 100 * (now[2] - prev[2]) / dt / cores) if now[2] else None
    mi = _meminfo()
    cg = _cgroup()
    used_by_me = _limit(cg, "memory.current")
    return dict(
        cores=cores,
        cpu=round(cpu, 1),                                   # % of the whole machine
        cpu_reader=round(mine, 1) if mine is not None else None,
        load=round(os.getloadavg()[0], 2),
        mem_total=mi.get("MemTotal"),
        mem_available=mi.get("MemAvailable"),
        mem_reader=used_by_me,
        mem_reader_high=_limit(cg, "memory.high"),           # past this the kernel squeezes the service
        mem_reader_max=_limit(cg, "memory.max"),             # past this only the service is killed (and restarts)
        swap_total=mi.get("SwapTotal"),
        swap_used=(mi["SwapTotal"] - mi["SwapFree"]) if "SwapTotal" in mi else None,
        temp=_temp(),
        power=_power(),
    )
