import { vehicleProfile } from './vehicleProfiles.js';
export function missionEvidence(analysis, settings, point, route) {
  const p=analysis?.metadata?.provenance||{}, model=analysis?.metadata?.analysisModel;
  const gsd=p.metric ? p.analysis_gsd : null;
  const sourceGsd=p.metric && Number.isFinite(p.source_gsd) && p.source_gsd>0?p.source_gsd:null;
  const screeningGsd=Number.isFinite(gsd)&&gsd>0?Math.max(gsd,sourceGsd||gsd):null;
  const width=Number(settings.obstacleWidth),requiredGsd=width>0?width/3:null;
  const sampled=screeningGsd!==null&&requiredGsd!==null;
  const resolves=sampled&&screeningGsd<=requiredGsd;
  const slope=Number.isFinite(point?.metrics?.slope)&&Number.isFinite(model?.slope?.max)?point.metrics.slope*model.slope.max:null;
  return {schema:'bhuvan-mission-evidence/1',dataset:p.dataset_id||null,source:p.source||null,body:p.body||null,vehicle:vehicleProfile(settings.profileId).name,
    referenceFrame:p.reference||null,verticalDatum:p.vertical_reference||null,
    sourceWindows:(p.acquisition?.products||[]).map(s=>({dataset:s.dataset_id,window:s.window,affine:s.affine,reference:s.catalogue?.reference||null,qualityMaps:s.catalogue?.quality_maps||null,qualityMapsStatus:s.catalogue?.quality_maps_status||null})),
    observedSourceSpacingM:sourceGsd,analysisSpacingM:gsd,screeningSpacingM:screeningGsd,criticalObstacleWidthM:width,requiredSpacingM:requiredGsd,
    samplesAcrossObstacle:sampled?width/screeningGsd:null,decision:!sampled?'UNKNOWN SCALE':resolves?'SAMPLING CHECK PASSES; VALIDATION REQUIRED':'SMALL HAZARDS UNRESOLVED',
    samplingRule:'At least three cells across the specified feature: an experiment assumption, not a validated detector.',
    position:point?{x:point.x,z:point.z,elevation:point.metrics?.elevation}:null,
    slopeDegreesLowerBound:slope,gradeLimitDegrees:settings.maxSlope,gradeExceeded:slope===null||(point?.metrics?.slope>=1&&settings.maxSlope>=slope)?null:slope>settings.maxSlope,
    route:route?{distanceM:route.distance,maximumGradeDegrees:route.maxSlope,maximumHazardIndex:route.maxHazard,contactGapM:route.maxUnsupportedHeight}:null,
    nextData:resolves?'Verify vertical uncertainty, registration, ground truth and vehicle-soil interaction.':requiredGsd?`Acquire stereo/lidar or surveyed terrain at ${requiredGsd.toFixed(3)} m spacing or finer, plus uncertainty and mapped obstacles.`:'Supply a metric DEM and a critical obstacle width.',
    limitations:['Sampling sufficiency alone does not establish obstacle detection or safety.','Hazard is a heuristic index, not failure probability; traversability is 1 minus that index.','No measured vertical-error distribution, soil mechanics or landing dynamics; probability of mission loss is not estimable.']};
}
