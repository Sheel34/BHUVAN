"""Reproducible analytical fixtures and resolution/perturbation experiments.

Validation of discrete operators is distinct from validating hazard thresholds
or real-world safety. No source elevation error model is inferred here.
"""
from __future__ import annotations

import time
import tracemalloc

import cv2
import numpy as np

from .terrain_analysis import analyze_terrain, _slope_degrees, _roughness_std, _curvature_laplacian
from .landing_zones import rank_landing_zones, HAZARD_SAFE_THRESHOLD, MIN_SAFE_RADIUS_M


def analytical_surfaces(size=129, spacing=1.):
    axis=(np.arange(size)-(size-1)/2)*spacing
    x,y=np.meshgrid(axis,axis)
    a=.0002; amplitude=1.; k=.035; l=.025; sigma=20.
    flat=lambda x,y:np.zeros_like(x)
    plane=lambda x,y:x*np.tan(np.deg2rad(10.))
    paraboloid=lambda x,y:a*(x*x+y*y)
    sinusoid=lambda x,y:amplitude*np.sin(k*x)*np.cos(l*y)
    pit=lambda x,y:-2*np.exp(-(x*x+y*y)/(2*sigma*sigma))
    step=lambda x,y:np.where(x>=0,2.,0.)
    kernel=min(max(3,int(6/spacing)),size)
    if kernel%2==0:kernel+=1
    offsets=(np.arange(kernel)-kernel//2)*spacing
    surfaces=[]
    for name,function in [('flat',flat),('known-angle plane',plane),('paraboloid',paraboloid),('sinusoid',sinusoid),('step',step),('isolated pit',pit)]:
        elevation=function(x,y)
        if name=='flat': gx=gy=lap=np.zeros_like(x)
        elif name=='known-angle plane': gx=np.full_like(x,np.tan(np.deg2rad(10.)));gy=lap=np.zeros_like(x)
        elif name=='paraboloid': gx=2*a*x;gy=2*a*y;lap=np.full_like(x,4*a)
        elif name=='sinusoid': gx=amplitude*k*np.cos(k*x)*np.cos(l*y);gy=-amplitude*l*np.sin(k*x)*np.sin(l*y);lap=-(k*k+l*l)*elevation
        elif name=='isolated pit': gx=-x/sigma**2*elevation;gy=-y/sigma**2*elevation;lap=elevation*((x*x+y*y)/sigma**4-2/sigma**2)
        else: gx=gy=lap=np.zeros_like(x)
        # Exact finite-window standard deviation of analytical samples.
        mean=np.zeros_like(x);mean_sq=np.zeros_like(x)
        for dy in offsets:
            for dx in offsets:
                values=function(x+dx,y+dy);mean+=values;mean_sq+=values*values
        mean/=kernel**2;mean_sq/=kernel**2
        expected={'slope':np.degrees(np.arctan(np.hypot(gx,gy))),
                  'roughness':np.sqrt(np.maximum(mean_sq-mean*mean,0)), 'curvature':np.abs(lap)}
        margin=kernel//2+1
        valid=np.zeros_like(x,dtype=bool);valid[margin:-margin,margin:-margin]=True
        if name=='step':valid &= np.abs(x)>spacing*(kernel//2+2)
        surfaces.append({'name':name,'elevation':elevation+1000.,'spacing':spacing,'expected':expected,'valid':valid,
                         'truth':'continuous derivatives; exact finite-window sample standard deviation' if name!='step' else 'flat regions only; derivative at discontinuity is undefined'})
    return surfaces


def validation_report(size=129, spacing=1.):
    records=[]
    for fixture in analytical_surfaces(size,spacing):
        elevation=fixture['elevation']-fixture['elevation'].min()
        actual={'slope':_slope_degrees(elevation,spacing),'roughness':_roughness_std(elevation,spacing),
                'curvature':_curvature_laplacian(elevation,spacing)}
        for metric,expected in fixture['expected'].items():
            e=expected[fixture['valid']];v=actual[metric][fixture['valid']];delta=v-e
            norm=float(np.linalg.norm(e))
            records.append({'surface':fixture['name'],'metric':metric,'truth':fixture['truth'],
                            'expected_mean':float(e.mean()),'actual_mean':float(v.mean()),
                            'mean_absolute_error':float(np.abs(delta).mean()),'maximum_absolute_error':float(np.abs(delta).max()),
                            'relative_l2_error':float(np.linalg.norm(delta)/norm) if norm>1e-12 else None,
                            'relative_error_note':'undefined for zero truth' if norm<=1e-12 else None,
                            'unit':{'slope':'degrees','roughness':'m','curvature':'1/m'}[metric]})
    return {'kind':'analytical operator validation; heuristic hazard thresholds are not validated',
            'shape':[size,size],'gsd_m':spacing,'boundary':'kernel halo excluded; step discontinuity excluded', 'records':records}


def _aligned_resample(grid,size,method=cv2.INTER_LINEAR):
    axis=np.linspace(0,grid.shape[0]-1,size,dtype=np.float32)
    xx,yy=np.meshgrid(axis,axis)
    return cv2.remap(grid,xx,yy,method)


def resolution_sensitivity(elevation, source_gsd, provenance=None, requested_gsds=None):
    """ONE source window, identical extent and algorithms at each analysis GSD."""
    extent=(elevation.shape[0]-1)*source_gsd
    gsds=requested_gsds or [source_gsd*factor for factor in (1,2,4,8,16)]
    if min(gsds)<source_gsd:
        raise ValueError('Cannot manufacture a finer available reference from a coarse source')
    records=[];reference=None;reference_zones=[]
    for requested in gsds:
        size=max(3,int(round(extent/requested))+1);spacing=extent/(size-1)
        grid=_aligned_resample(elevation,size)
        tracemalloc.start();start=time.perf_counter()
        layers=analyze_terrain(grid,spacing)
        zones=rank_landing_zones(grid,layers,scale_m=extent,compute_uncertainty=False)
        elapsed=(time.perf_counter()-start)*1000
        _,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
        if reference is None:reference=layers;reference_zones=zones
        native_size=reference['hazard']['data'].shape[0]
        projected={key:_aligned_resample(value['data'],native_size) for key,value in layers.items()}
        hazard_class=_aligned_resample((layers['hazard']['data']<HAZARD_SAFE_THRESHOLD).astype(np.float32),native_size,cv2.INTER_NEAREST)>0
        ref_class=reference['hazard']['data']<HAZARD_SAFE_THRESHOLD
        matches=[];remaining=set(range(len(zones)))
        for rank,rz in enumerate(reference_zones):
            if not remaining:break
            match=min(remaining,key=lambda i:np.hypot(zones[i].x-rz.x,zones[i].z-rz.z));remaining.remove(match)
            matches.append({'reference_rank':rank+1,'rank':match+1,'rank_change':match-rank,
                            'displacement_m':float(np.hypot(zones[match].x-rz.x,zones[match].z-rz.z))})
        top=float(np.hypot(zones[0].x-reference_zones[0].x,zones[0].z-reference_zones[0].z)) if zones and reference_zones else None
        records.append({'shape':[size,size],'requested_gsd_m':requested,'analysis_gsd_m':spacing,
            'processing_ms':elapsed,'python_tracked_peak_bytes':peak,
            'retained_analysis_array_bytes':sum(v['data'].nbytes for v in layers.values()),
            'mean_absolute_clipped_slope_difference_degrees':float(np.abs(projected['slope']-reference['slope']['data']).mean()*15),
            'mean_absolute_clipped_roughness_difference_m':float(np.abs(projected['roughness']-reference['roughness']['data']).mean()*.5),
            'hazard_classification_agreement':float((hazard_class==ref_class).mean()),
            'safe_area_fraction':float((layers['hazard']['data']<.35).mean()),
            'candidate_region_count':len(zones),'largest_candidate_area_m2_approx':max((z.patch_area_px*spacing**2 for z in zones),default=0.),
            'top_candidate_displacement_m':top,'spatial_rank_matches':matches})
    return {'reference':'highest-resolution available reference; not physical ground truth',
            'source_provenance':provenance or {'status':'SYNTHETIC controlled test'},'extent_m':extent,
            'analysis_window':{'shape':list(elevation.shape),'source_gsd_m':source_gsd},
            'resampling':'endpoint-aligned bilinear interpolation, no antialias prefilter; classification compared using nearest sampling',
            'model':'unchanged clipped/normalized hazard model; safe <0.35, candidate <0.42; assumed-index uncertainty excluded from timing',
            'scale_limitation':'Legacy roughness uses at least three cells; its physical footprint changes with GSD. Sensitivity includes this operator-scale effect.',
            'rank_matching':'greedy nearest candidate centre; IDs are not stable across segmentation/resolution',
            'memory_note':'tracked Python/NumPy allocations; not VRAM and not total process RSS', 'records':records}


def elevation_perturbation_sensitivity(elevation, spacing, sigma_m, realizations=16, seed=0):
    """Assumed elevation perturbations rerun DEM → derivatives → regions.

    This development experiment does NOT assert a measured DEM uncertainty.
    No spatial covariance is modeled. Candidate statistics use each reference
    candidate's fixed ranking footprint, not pooled regions.
    """
    if not np.isfinite(sigma_m) or sigma_m<0 or not 2<=realizations<=64 or max(elevation.shape)>1025:
        raise ValueError('A finite nonnegative assumed sigma, 2–64 realizations and a bounded analysis window are required')
    extent=(elevation.shape[0]-1)*spacing
    baseline=analyze_terrain(elevation,spacing)
    zones=rank_landing_zones(elevation,baseline,scale_m=extent,compute_uncertainty=False)
    kernel_px=max(1,int(np.ceil(MIN_SAFE_RADIUS_M/spacing)))
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(kernel_px*2+1,)*2)
    masks={}
    for zone in zones:
        i=round((zone.x/extent+.5)*(elevation.shape[0]-1));j=round((zone.z/extent+.5)*(elevation.shape[1]-1))
        mask=np.zeros(elevation.shape,bool)
        for dy,dx in np.argwhere(kernel):
            r,c=i+dy-kernel_px,j+dx-kernel_px
            if 0<=r<mask.shape[0] and 0<=c<mask.shape[1]:mask[r,c]=True
        masks[zone.id]=mask
    samples={z.id:{'mean_hazard':[],'score':[],'candidate_nearby':[]} for z in zones}
    rng=np.random.default_rng(seed)
    for _ in range(realizations):
        perturbed=elevation+rng.normal(0,sigma_m,elevation.shape)
        layers=analyze_terrain(perturbed,spacing)
        candidates=rank_landing_zones(perturbed,layers,scale_m=extent,compute_uncertainty=False)
        for zone in zones:
            hazard=layers['hazard']['data'][masks[zone.id]]
            samples[zone.id]['mean_hazard'].append(float(hazard.mean()))
            samples[zone.id]['score'].append(float((1-hazard.max())*100*zone.confidence))
            samples[zone.id]['candidate_nearby'].append(any(np.hypot(c.x-zone.x,c.z-zone.z)<=max(spacing*2,MIN_SAFE_RADIUS_M) for c in candidates))
    records=[]
    for zone in zones:
        values=samples[zone.id]
        records.append({'candidate_id':zone.id,'reference_x':zone.x,'reference_z':zone.z,
                        'fixed_footprint_cells':int(masks[zone.id].sum()),
                        'mean_hazard_percentiles':np.percentile(values['mean_hazard'],[2.5,50,97.5]).tolist(),
                        'score_percentiles':np.percentile(values['score'],[2.5,50,97.5]).tolist(),
                        'nearby_candidate_fraction':float(np.mean(values['candidate_nearby']))})
    return {'kind':'ASSUMED source-elevation perturbation sensitivity; not measured source uncertainty or validated safety',
            'sigma_m':sigma_m,'noise':'independent Gaussian elevation errors; no spatial covariance',
            'realizations':realizations,'seed':seed,'analysis_gsd_m':spacing,
            'pipeline_recomputed':['elevation','slope','roughness','curvature','hazard','candidate regions'],
            'candidate_matching':'within max(2 cells, minimum footprint radius); fixed reference footprint statistics are separate',
            'records':records}
