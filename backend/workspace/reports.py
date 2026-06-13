"""Report rendering — analysis record → professional markdown.

Four report kinds, each a different lens on the same intelligence
bundle. Markdown keeps reports portable: render in-app, export as .md,
or print to PDF from the browser.
"""

from __future__ import annotations

import time

REPORT_KINDS = {
    "summary": "Terrain Summary",
    "surface": "Surface Analysis",
    "risk": "Risk Assessment",
    "geology": "Geological Overview",
}


def _header(record: dict, title: str) -> str:
    meta = record["metadata"]
    stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    return (
        f"# {title}\n\n"
        f"**Site:** {record['name']}  \n"
        f"**Source:** {meta.get('source', 'unknown')}  \n"
        f"**Coverage:** {meta.get('world_scale_m', 0) / 1000:.1f} km × "
        f"{meta.get('world_scale_m', 0) / 1000:.1f} km at "
        f"{meta.get('resolution_m_per_px', 0):.1f} m/px  \n"
        f"**Generated:** {stamp}  \n"
        f"**Analysis ID:** `{record['job_id']}`\n\n"
        f"> {meta.get('disclaimer') or 'Derived from automated terrain analysis; verify before operational use.'}\n\n"
        "---\n\n"
    )


def _elevation_section(intel: dict) -> str:
    e = intel["elevation"]
    return (
        "## Elevation Profile\n\n"
        f"| Metric | Value |\n|---|---|\n"
        f"| Relief (total) | {e['relief_m']:.0f} m |\n"
        f"| Minimum | {e['min_m']:.0f} m |\n"
        f"| Maximum | {e['max_m']:.0f} m |\n"
        f"| Mean | {e['mean_m']:.0f} m |\n"
        f"| Median | {e['median_m']:.0f} m |\n"
        f"| Std deviation | {e['std_m']:.0f} m |\n"
        f"| 5th–95th percentile | {e['p5_m']:.0f} – {e['p95_m']:.0f} m |\n\n"
    )


def _classification_section(intel: dict) -> str:
    c = intel["classification"]
    lines = ["## Surface Classification\n\n", "| Class | Coverage | Notes |\n|---|---|---|\n"]
    for cls in c["classes"]:
        lines.append(f"| {cls['label']} | {cls['coverage_pct']:.1f}% | {cls['description']} |\n")
    lines.append(f"\nDominant surface type: **{c['dominant']}**.\n\n")
    return "".join(lines)


def _regions_section(intel: dict) -> str:
    lines = ["## Major Regions\n\n"]
    if not intel["regions"]:
        return lines[0] + "No contiguous regions above reporting threshold.\n\n"
    lines.append("| Region | Area | Share | Centroid (x, z) |\n|---|---|---|---|\n")
    for r in intel["regions"][:8]:
        lines.append(
            f"| {r['class_label']} | {r['area_km2']:.2f} km² | {r['coverage_pct']:.1f}% "
            f"| {r['x']:.0f} m, {r['z']:.0f} m |\n"
        )
    return "".join(lines) + "\n"


def _interest_section(intel: dict) -> str:
    lines = ["## Scientific-Interest Regions\n\n"]
    if not intel["interest_regions"]:
        return lines[0] + "No high-interest regions identified.\n\n"
    for poi in intel["interest_regions"]:
        ev = poi["evidence"]
        lines.append(
            f"### {poi['id'].upper()} — {poi['kind']}\n\n"
            f"- Location: ({poi['x']:.0f} m, {poi['z']:.0f} m), elevation {poi['elevation_m']:.0f} m\n"
            f"- Interest score: {poi['score']:.2f}\n"
            f"- Evidence: curvature {ev['curvature']:.2f}, slope {ev['slope']:.2f}, "
            f"roughness {ev['roughness']:.2f}\n\n"
        )
    return "".join(lines)


def _risk_section(record: dict, intel: dict) -> str:
    meta = record["metadata"]
    steep = next((c for c in intel["classification"]["classes"] if c["key"] == "steep"), None)
    rough = next((c for c in intel["classification"]["classes"] if c["key"] == "rough"), None)
    safe_pct = meta.get("safe_area_pct", 0.0)
    risk_level = "LOW" if safe_pct > 70 else "MODERATE" if safe_pct > 40 else "HIGH"
    return (
        "## Risk Assessment\n\n"
        f"**Overall surface risk: {risk_level}** — {safe_pct:.1f}% of the analyzed "
        "area falls below the hazard threshold.\n\n"
        f"- Steep terrain coverage: {steep['coverage_pct'] if steep else 0:.1f}%\n"
        f"- Broken/rough ground coverage: {rough['coverage_pct'] if rough else 0:.1f}%\n"
        f"- Total relief to manage: {intel['elevation']['relief_m']:.0f} m\n\n"
    )


def render_report(record: dict, kind: str) -> str:
    """Render one report kind from a stored analysis record."""
    if kind not in REPORT_KINDS:
        raise ValueError(f"Unknown report kind '{kind}'. Valid: {list(REPORT_KINDS)}")
    intel = record.get("intelligence")
    if not intel:
        raise ValueError("Analysis record has no intelligence bundle to report on.")

    title = REPORT_KINDS[kind]
    doc = _header(record, title)

    if kind == "summary":
        doc += _elevation_section(intel)
        doc += _classification_section(intel)
        doc += _risk_section(record, intel)
        doc += _interest_section(intel)
    elif kind == "surface":
        doc += _classification_section(intel)
        doc += _regions_section(intel)
        doc += _elevation_section(intel)
    elif kind == "risk":
        doc += _risk_section(record, intel)
        doc += _classification_section(intel)
    elif kind == "geology":
        doc += _interest_section(intel)
        doc += _regions_section(intel)
        doc += _elevation_section(intel)

    doc += "\n---\n*BHUVAN // Planetary Intelligence Platform — automated analysis report.*\n"
    return doc
