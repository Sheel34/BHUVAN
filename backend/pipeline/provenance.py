"""Source fidelity and analysis assumptions, independent of visualization."""
from .terrain_analysis import HAZARD_WEIGHTS


def describe_dataset(metadata: dict, size: int, spacing: float) -> tuple[dict, dict]:
    source = metadata.get("source", "unknown")
    estimated = "image" in source or "depth" in source or "ai-enhanced" in source
    synthetic = "procedural" in source or "fallback" in source
    status = "ESTIMATED" if estimated else "SYNTHETIC" if synthetic else "MEASURED"
    calibrated_dem_estimate = "ai-enhanced" in source and any(kind in source for kind in ("geotiff", "lola-dem", "hirise-dtm", "srtm"))
    metric = not estimated or calibrated_dem_estimate
    body = metadata.get("body")
    if not body:
        text = (source + " " + metadata.get("terrain_name", "")).lower()
        body = "moon" if "lola" in text or "moon" in text or "lunar" in text or "shackleton" in text or "tycho" in text or "mare" in text else "mars" if "mars" in text or "hirise" in text else "earth" if "srtm" in text or metadata.get("earth_crs") else "unknown"
    provenance = {
        "status": status, "source": source,
        "dataset_id": metadata.get("dataset_id", metadata.get("terrain_name", source)),
        "body": body, "reference": metadata.get("crs", "local test coordinates"),
        "metric": metric, "elevation_unit": "m" if metric else "relative units",
        "analysis_gsd": spacing if metric else None,
        "source_gsd": metadata.get("native_resolution_m_per_px", spacing if synthetic else None),
        "source_shape": [metadata.get("original_height", size), metadata.get("original_width", size)],
        "window": metadata.get("window"), "bounds": metadata.get("bounds"),
        "affine": metadata.get("affine"),
        "horizontal_unit":metadata.get("horizontal_unit", "m" if metadata.get("acquisition") or synthetic else "source CRS units; verify label"),
        "origin_lat": metadata.get("lat"), "origin_lon": metadata.get("lon"),
        "vertical_reference": metadata.get("vertical_reference", "unspecified; source band assumed metres" if metric else "uncalibrated relative depth"),
        "resampled": bool(metadata.get("resampled", False)),
        "analysis_window": {"shape":[size,size],"extent":metadata.get("world_scale_m"),
                            "bounds":metadata.get("bounds"),"spacing":spacing,
                            "resampling":metadata.get("acquisition",{}).get("reprojection", "none" if not metadata.get("resampled") else "ingestion resampling")},
        "local_frame": "local azimuthal equidistant" if metadata.get("acquisition") else "source projected/local raster coordinates",
        "reference_model": metadata.get("reference_model", {"body":"moon","radius_m":1737400.,"kind":"reference sphere; source label must agree"} if body=="moon" else {"body":"earth","kind":"dataset CRS; vertical datum separately retained"} if body=="earth" else None),
        "transport": "legacy full-raster JSON; binary tile transport is opt-in",
        "acquisition": metadata.get("acquisition"),
        "surface_imagery":metadata.get('surface_imagery'),
        "limitations": [metadata.get("disclaimer") or "Source uncertainty not supplied.",
            "Scientific analysis uses a bounded in-memory patch; rendering transport/LOD does not change analysis GSD.",
            "No source error model or planetary frame epoch supplied."],
    }
    if not metric:
        provenance["limitations"].append("Display aspect/relief are arbitrary. No metric slope, roughness, footprint or suitability claim is supported.")
    model = {
        "kind": "heuristic, unvalidated", "weights": HAZARD_WEIGHTS,
        "slope": {"min": 0, "max": 15, "unit": "degrees" if metric else "index", "clipped": True},
        "roughness": {"min": 0, "max": .5, "unit": "m" if metric else "index", "clipped": True,
            "method": "local elevation standard deviation; includes slope", "window": "max(3 cells, nominal 6 units), limited by patch size"},
        "curvature": "absolute five-point Laplacian; unsigned bending, not ridge/basin identification",
        "shadow": "local back-facing orientation proxy at azimuth 40°, elevation 45°; no horizon/occlusion computation or ephemeris",
        "candidate_threshold": .42, "low_hazard_threshold": .35,
        "candidate_min_radius": 4 if metric else None,
        "uncertainty": "per-footprint sensitivity to assumed independent Gaussian hazard-index noise (sigma 0.02); not measured DEM uncertainty or probabilistic safety",
        "model_sensitivity": {"kind":"final hazard-index perturbation","sigma":.02,"candidate_specific":True},
        "source_elevation_uncertainty": {"propagated":False,"reason":"No source covariance/error distribution supplied; DEM-to-candidate Monte Carlo is a separate validation experiment."},
        "traversability": "1 − hazard; no vehicle constraints",
    }
    return provenance, model
