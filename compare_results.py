#!/usr/bin/env python3
"""Count where a reviewer disagreed with the LLM judge, from a results file downloaded from the page.

    python3 compare_results.py results.jsonl [more_results.jsonl ...] [--list] [--unclear skip|pass|fail]

Each example has one verdict pair per criterion, so 100 examples give 300 pairs. For each file this
reports the disagreements between the reviewer (user_*) and the judge:

1. in total,
2. per criterion (al_rules, al_consistency, stylistic),
3. per criterion and judge verdict, next to how the reviewer split pass/fail.

The judge's stylistic verdict is appropriate / inappropriate / unclear: appropriate counts as pass and
inappropriate as fail. "unclear" has no pass/fail to compare with, so by default those pairs get their
own row and are left out of the disagreement counts; --unclear pass or --unclear fail counts them as
that verdict instead. Pairs the reviewer left unanswered, or where the judge gave no verdict, are left
out as well, and the report says how many.

Rows from a stratified sample carry sample_weight. For those files the rates are also given weighted
by it, which estimates the rates for the whole judge file; the plain rates overstate the rare verdict
combinations that stratified sampling over-represents.

--list prints every disagreement with the reviewer's justification.

Only uses the Python standard library.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

CRITERIA = ("al_rules", "al_consistency", "stylistic")
# The judge's verdicts on the reviewer's pass/fail scale.
PASS_FAIL = {"pass": "pass", "fail": "fail", "appropriate": "pass", "inappropriate": "fail"}
# Display order of judge verdicts within a criterion; anything else sorts after these.
ORDER = ("pass", "appropriate", "fail", "inappropriate", "unclear", "no verdict")
COMPARED = ("agree", "disagree")
SKIP_REASONS = {
    "unclear": 'where the judge said "unclear"',
    "no judge verdict": "where the judge gave no verdict",
    "unanswered": "the reviewer left unanswered",
}


def load(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"{path}:{n}: not valid JSON ({e.msg})")
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{n}: expected a JSON object")
            rows.append(row)
    if not rows:
        raise SystemExit(f"{path}: no rows")
    if not any(f"user_{c}" in row for row in rows for c in CRITERIA):
        raise SystemExit(f"{path}: no user_* fields; is this a results file downloaded from the page?")
    return rows


def _verdict(value) -> str | None:
    return value.strip().lower() if isinstance(value, str) and value.strip() else None


def _weight(row: dict) -> float | None:
    w = row.get("sample_weight")
    return float(w) if isinstance(w, (int, float)) and not isinstance(w, bool) and w > 0 else None


def compare(rows: list[dict], unclear: str = "skip") -> list[dict]:
    """One record per (example, criterion) pair, with its status: agree, disagree or a skip reason."""
    pairs = []
    for example, row in enumerate(rows, 1):
        for c in CRITERIA:
            judge = _verdict(row.get(c)) or "no verdict"
            user = _verdict(row.get(f"user_{c}"))
            user = user if user in ("pass", "fail") else None
            judge_pf = PASS_FAIL.get(judge)
            if judge == "unclear" and unclear != "skip":
                judge_pf = unclear
            if user is None:
                status = "unanswered"
            elif judge_pf is None:
                status = "unclear" if judge == "unclear" else "no judge verdict"
            else:
                status = "agree" if user == judge_pf else "disagree"
            pairs.append({
                "example": example,
                "criterion": c,
                "judge": judge,
                "judge_pf": judge_pf,
                "user": user,
                "status": status,
                "weight": _weight(row),
                "row": row,
            })
    return pairs


def tally(pairs: list[dict]) -> dict:
    """Counts for a group of pairs; weighted_rate only when every compared pair has a sample_weight."""
    compared = [p for p in pairs if p["status"] in COMPARED]
    disagree = [p for p in compared if p["status"] == "disagree"]
    out = {
        "pairs": len(pairs),
        "compared": len(compared),
        "disagree": len(disagree),
        "user_pass": sum(p["user"] == "pass" for p in pairs),
        "user_fail": sum(p["user"] == "fail" for p in pairs),
        "unanswered": sum(p["user"] is None for p in pairs),
        "skipped": Counter(p["status"] for p in pairs if p["status"] not in COMPARED),
    }
    if compared and all(p["weight"] is not None for p in compared):
        out["weighted_rate"] = sum(p["weight"] for p in disagree) / sum(p["weight"] for p in compared)
    return out


def summarize(pairs: list[dict]) -> dict:
    """The three breakdowns: total, per criterion, per criterion and judge verdict."""
    by_criterion = {c: tally([p for p in pairs if p["criterion"] == c]) for c in CRITERIA}
    by_judge = {}
    for c in CRITERIA:
        group = [p for p in pairs if p["criterion"] == c]
        labels = sorted({p["judge"] for p in group}, key=lambda v: (ORDER.index(v) if v in ORDER else len(ORDER), v))
        by_judge[c] = {label: tally([p for p in group if p["judge"] == label]) for label in labels}
    return {"total": tally(pairs), "by_criterion": by_criterion, "by_judge": by_judge}


# ------------------------------------------------------------------------------------------- report

def _pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def _rate(t: dict) -> str:
    return _pct(t["disagree"] / t["compared"]) if t["compared"] else "–"


def _table(headers: list[str], rows: list[list], align: str) -> str:
    cells = [headers] + [[str(x) for x in r] for r in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(headers))]

    def line(r):
        return "  ".join(v.ljust(w) if a == "l" else v.rjust(w) for v, w, a in zip(r, widths, align)).rstrip()

    lines = [line(cells[0]), "  ".join("-" * w for w in widths)] + [line(r) for r in cells[1:]]
    return "\n".join("  " + text for text in lines)


def report(path: Path, rows: list[dict], pairs: list[dict], unclear: str, show_list: bool) -> str:
    s = summarize(pairs)
    total = s["total"]
    weighted = "weighted_rate" in total
    out = [f"== {path.name}"]
    kind = "stratified sample" if weighted else "sample"
    out.append(f"{len(rows)} examples x {len(CRITERIA)} criteria = {total['pairs']} verdict pairs ({kind})")
    if unclear != "skip":
        out.append(f'Judge "unclear" stylistic verdicts are counted as {unclear}.')
    out.append("")

    # 1. Total
    line = f"Total disagreements: {total['disagree']} / {total['compared']} compared pairs ({_rate(total)})"
    if weighted:
        line += f"; weighted estimate for the whole judge file: {_pct(total['weighted_rate'])}"
    out.append(line)
    if total["skipped"]:
        parts = [f"{n} {SKIP_REASONS.get(reason, reason)}" for reason, n in total["skipped"].most_common()]
        out.append(f"Not compared: {'; '.join(parts)}")
    out.append("")

    # 2. By criterion
    headers = ["criterion", "compared", "disagree", "rate"] + (["weighted"] if weighted else [])
    table_rows = []
    for c, t in s["by_criterion"].items():
        r = [c, t["compared"], t["disagree"], _rate(t)]
        if weighted:
            r.append(_pct(t["weighted_rate"]) if "weighted_rate" in t else "–")
        table_rows.append(r)
    out += ["By criterion", _table(headers, table_rows, "lrrr" + ("r" if weighted else "")), ""]

    # 3. By criterion and judge verdict
    any_unanswered = total["unanswered"] > 0
    headers = ["criterion", "judge", "user pass", "user fail"] + (["no answer"] if any_unanswered else [])
    headers += ["disagree", "rate"] + (["weighted"] if weighted else [])
    table_rows = []
    for c, cells in s["by_judge"].items():
        for i, (label, t) in enumerate(cells.items()):
            mapped = PASS_FAIL.get(label) or (unclear if label == "unclear" and unclear != "skip" else None)
            shown = label if mapped in (None, label) else f"{label} = {mapped}"
            r = [c if i == 0 else "", shown, t["user_pass"], t["user_fail"]]
            if any_unanswered:
                r.append(t["unanswered"])
            r += [t["disagree"], _rate(t)] if mapped else ["–", "–"]
            if weighted:
                r.append(_pct(t["weighted_rate"]) if mapped and "weighted_rate" in t else "–")
            table_rows.append(r)
    align = "ll" + "r" * (len(headers) - 2)
    out += ["By criterion and judge verdict", _table(headers, table_rows, align)]

    if show_list:
        out += ["", "Disagreements"]
        dis = [p for p in pairs if p["status"] == "disagree"]
        if not dis:
            out.append("  (none)")
        for p in dis:
            row = p["row"]
            note = str(row.get(f"user_{p['criterion']}_justification") or "").strip()
            verdicts = f"judge {p['judge']}, user {p['user']}"
            out.append(
                f"  #{p['example']:<4} {p['criterion']:<15} {verdicts:<31} "
                f"{row.get('plan_id', '?')} · clip {row.get('clip_id', '?')}"
            )
            out.append(f"         {note if note else '(no justification)'}")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="Count reviewer/judge disagreements in results files from the page.")
    ap.add_argument("files", nargs="+", type=Path, help="results .jsonl downloaded from the page")
    ap.add_argument("--unclear", choices=("skip", "pass", "fail"), default="skip",
                    help='how to count the judge\'s "unclear" stylistic verdicts (default: leave them out)')
    ap.add_argument("--list", action="store_true", help="print every disagreement with its justification")
    args = ap.parse_args()

    reports = []
    for path in args.files:
        rows = load(path)
        reports.append(report(path, rows, compare(rows, args.unclear), args.unclear, args.list))
    print("\n\n".join(reports))


if __name__ == "__main__":
    main()
