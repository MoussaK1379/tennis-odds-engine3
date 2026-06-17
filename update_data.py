#!/usr/bin/env python3
"""
update_data.py — rebuild players.json from Jeff Sackmann's public match data.

Pulls tour-level main-draw results for ATP and WTA, computes surface-specific
Elo ratings (hard / clay / grass + overall) and serve / return point-win rates,
then writes players.json in the exact schema the web app reads.

Runs anywhere with internet + Python 3.8+. No third-party packages required.
On GitHub Actions this runs on a schedule; the result is committed and Netlify
redeploys automatically.

    python update_data.py                 # default: last 8 seasons, both tours
    python update_data.py --years 10      # go back further for steadier Elo
    python update_data.py --tours atp     # one tour only
    python update_data.py --local f.csv   # build from a local CSV (testing)
"""

import argparse, csv, io, json, math, re, sys, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

ATP_URL = "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_{y}.csv"
WTA_URL = "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_{y}.csv"

K = 32                 # Elo update factor
BASE = 1500            # Elo starting rating
MIN_RECENT_MATCHES = 8 # how many recent matches to count as an "active" tour player
SURFACE_MIN = 5        # min matches on a surface before trusting its surface split

SURFACES = ("hard", "clay", "grass")


def slug(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower()) or "unknown"


def fetch_csv(url):
    req = urllib.request.Request(url, headers={"User-Agent": "deuce-updater/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def load_rows(tours, years, local):
    """Yield (tour, dict-row) for every match, oldest first."""
    if local:
        with open(local, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                yield "ATP", row
        return
    this_year = datetime.now(timezone.utc).year
    year_list = list(range(this_year - years + 1, this_year + 1))
    plan = []
    if "atp" in tours:
        plan += [("ATP", ATP_URL, y) for y in year_list]
    if "wta" in tours:
        plan += [("WTA", WTA_URL, y) for y in year_list]
    for tour, tmpl, y in plan:
        url = tmpl.format(y=y)
        try:
            text = fetch_csv(url)
        except Exception as e:
            print(f"  skip {tour} {y}: {e}", file=sys.stderr)
            continue
        rows = list(csv.DictReader(io.StringIO(text)))
        print(f"  {tour} {y}: {len(rows)} matches", file=sys.stderr)
        for row in rows:
            yield tour, row


def norm_surface(s):
    s = (s or "").strip().lower()
    if s.startswith("hard") or s == "carpet":
        return "hard"
    if s.startswith("clay"):
        return "clay"
    if s.startswith("grass"):
        return "grass"
    return None


def fnum(row, key):
    try:
        v = row.get(key, "")
        return float(v) if v not in ("", None) else None
    except (TypeError, ValueError):
        return None


def build(tours, years, local):
    # rating state
    elo = defaultdict(lambda: BASE)
    elo_surf = {s: defaultdict(lambda: BASE) for s in SURFACES}
    # accumulators
    name_of = {}
    tour_of = {}
    n_matches = defaultdict(int)
    n_recent = defaultdict(int)
    surf_matches = defaultdict(lambda: defaultdict(int))
    serve_won = defaultdict(lambda: defaultdict(float))
    serve_pts = defaultdict(lambda: defaultdict(float))
    ret_won = defaultdict(lambda: defaultdict(float))
    ret_pts = defaultdict(lambda: defaultdict(float))
    tour_serve_won = defaultdict(float)
    tour_serve_pts = defaultdict(float)

    recent_cutoff = (datetime.now(timezone.utc).year - 2) * 10000  # ~ last 2 calendar years

    rows = list(load_rows(tours, years, local))
    # sort chronologically so Elo evolves in order
    def keyf(tr):
        d = tr[1].get("tourney_date") or "0"
        try:
            return int(d)
        except ValueError:
            return 0
    rows.sort(key=keyf)

    for tour, row in rows:
        wn, ln = row.get("winner_name"), row.get("loser_name")
        if not wn or not ln:
            continue
        wk, lk = slug(wn), slug(ln)
        name_of[wk], name_of[lk] = wn, ln
        tour_of[wk], tour_of[lk] = tour, tour
        surface = norm_surface(row.get("surface"))
        date = keyf((tour, row))

        # --- Elo ---
        rw, rl = elo[wk], elo[lk]
        exp_w = 1.0 / (1.0 + 10 ** ((rl - rw) / 400.0))
        elo[wk] = rw + K * (1 - exp_w)
        elo[lk] = rl - K * (1 - exp_w)
        if surface:
            sw, sl = elo_surf[surface][wk], elo_surf[surface][lk]
            esw = 1.0 / (1.0 + 10 ** ((sl - sw) / 400.0))
            elo_surf[surface][wk] = sw + K * (1 - esw)
            elo_surf[surface][lk] = sl - K * (1 - esw)
            surf_matches[wk][surface] += 1
            surf_matches[lk][surface] += 1

        n_matches[wk] += 1
        n_matches[lk] += 1
        if date >= recent_cutoff:
            n_recent[wk] += 1
            n_recent[lk] += 1

        # --- serve / return point stats (MatchStats present 1991+ for ATP/WTA tour) ---
        w_sv = fnum(row, "w_svpt"); l_sv = fnum(row, "l_svpt")
        w_sw = None; l_sw = None
        if fnum(row, "w_1stWon") is not None and fnum(row, "w_2ndWon") is not None:
            w_sw = fnum(row, "w_1stWon") + fnum(row, "w_2ndWon")
        if fnum(row, "l_1stWon") is not None and fnum(row, "l_2ndWon") is not None:
            l_sw = fnum(row, "l_1stWon") + fnum(row, "l_2ndWon")
        if surface and w_sv and l_sv and w_sw is not None and l_sw is not None and w_sv > 0 and l_sv > 0:
            # serve
            serve_won[wk][surface] += w_sw; serve_pts[wk][surface] += w_sv
            serve_won[lk][surface] += l_sw; serve_pts[lk][surface] += l_sv
            # return = points won while receiving = opp serve pts - opp serve pts won
            ret_won[wk][surface] += (l_sv - l_sw); ret_pts[wk][surface] += l_sv
            ret_won[lk][surface] += (w_sv - w_sw); ret_pts[lk][surface] += w_sv
            # tour baseline
            tour_serve_won[tour] += w_sw + l_sw
            tour_serve_pts[tour] += w_sv + l_sv

    # tour average serve points won
    tour_avg = {}
    for t in ("ATP", "WTA"):
        tour_avg[t] = round(tour_serve_won[t] / tour_serve_pts[t], 4) if tour_serve_pts[t] else (0.64 if t == "ATP" else 0.56)

    def rate(won, pts, key, surface, default):
        if pts[key].get(surface, 0) >= 40:  # ~ enough points to trust
            return won[key][surface] / pts[key][surface]
        # fall back: all-surface rate for the player
        tw = sum(won[key].values()); tp = sum(pts[key].values())
        if tp >= 40:
            return tw / tp
        return default

    players = {}
    active = [k for k in name_of if n_recent[k] >= MIN_RECENT_MATCHES]
    for k in active:
        t = tour_of[k]
        srv_def = tour_avg[t]
        ret_def = round(1 - tour_avg[t], 4)
        elo_o = round(elo[k])
        e, sv, rt = {}, {}, {}
        for s in SURFACES:
            e[s] = round(elo_surf[s][k]) if surf_matches[k].get(s, 0) >= SURFACE_MIN else elo_o
            sv[s] = round(max(0.45, min(0.85, rate(serve_won, serve_pts, k, s, srv_def))), 3)
            rt[s] = round(max(0.15, min(0.55, rate(ret_won, ret_pts, k, s, ret_def))), 3)
        e["overall"] = elo_o
        sv["overall"] = round(sum(sv[s] for s in SURFACES) / 3, 3)
        rt["overall"] = round(sum(rt[s] for s in SURFACES) / 3, 3)
        players[k] = {"name": name_of[k], "tour": t, "elo": e, "serve": sv, "return": rt}

    # tour-average pseudo players (used as model baselines / "Custom player")
    for t, key in (("ATP", "tour"), ("WTA", "wtatour")):
        if any(p["tour"] == t for p in players.values()):
            avg = tour_avg[t]
            players[key] = {
                "name": f"{t} tour average", "tour": t,
                "elo": {"hard": 1750 if t == "ATP" else 1650, "clay": 1750 if t == "ATP" else 1650,
                        "grass": 1750 if t == "ATP" else 1650, "overall": 1750 if t == "ATP" else 1650},
                "serve": {"hard": avg, "clay": round(avg - 0.015, 3), "grass": round(avg + 0.02, 3), "overall": avg},
                "return": {"hard": round(1 - avg, 3), "clay": round(1 - avg + 0.01, 3),
                           "grass": round(1 - avg - 0.02, 3), "overall": round(1 - avg, 3)},
            }

    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": "Jeff Sackmann tennis_atp / tennis_wta (CC BY-NC-SA). Computed by update_data.py.",
        "tours": {"ATP": {"tour_avg_spw": tour_avg["ATP"]}, "WTA": {"tour_avg_spw": tour_avg["WTA"]}},
        "tour_avg_spw": tour_avg["ATP"],
        "players": players,
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=8, help="seasons of history to use (default 8)")
    ap.add_argument("--tours", default="atp,wta", help="comma list: atp,wta")
    ap.add_argument("--local", help="build from a local CSV instead of downloading")
    ap.add_argument("--out", default="players.json")
    args = ap.parse_args()

    tours = {t.strip().lower() for t in args.tours.split(",") if t.strip()}
    print(f"Building players.json — tours={sorted(tours)} years={args.years}", file=sys.stderr)
    data = build(tours, args.years, args.local)

    counts = defaultdict(int)
    for p in data["players"].values():
        counts[p["tour"]] += 1
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0)
    print(f"Wrote {args.out}: {dict(counts)} players, tour avg {data['tours']}", file=sys.stderr)


if __name__ == "__main__":
    main()
