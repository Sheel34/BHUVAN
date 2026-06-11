/* ── Mission Report Generator ──
 * Produces a comprehensive, exportable JSON report with full evidence chain.
 * Designed for mission debrief, reproducibility, and technical audit.
 */

export function generateMissionReport(analysis, selectedZone, landerState, missionReport) {
  const timestamp = new Date().toISOString();
  const terrain = analysis?.terrain;
  const layers = analysis?.layers;
  const metadata = analysis?.metadata || {};

  // ── Terrain evidence ──
  const terrainEvidence = {
    name: metadata.terrainName || 'Unknown',
    source: metadata.source || 'unknown',
    gridSize: terrain?.size || 0,
    worldScaleM: terrain?.scale || 0,
    heightRangeM: terrain ? (terrain.maxH - terrain.minH).toFixed(2) : '0',
    safeAreaPct: metadata.safeAreaPct ?? null,
    crs: metadata.crs || null,
    nativeResolutionMPerPx: metadata.nativeResolutionMPerPx || null,
  };

  // ── Analysis methodology ──
  const methodology = {
    hazardWeights: {
      slope: 0.45,
      roughness: 0.25,
      curvature: 0.2,
      shadow: 0.1,
    },
    shadowMethod: 'ray-cast',
    sunAzimuthDeg: 40,
    sunElevationDeg: 45,
    safeThreshold: 0.42,
    minSafeRadiusM: 4.0,
    uncertaintyMethod: 'bootstrap',
    bootstrapSamples: 100,
    noiseStd: 0.02,
  };

  // ── Landing zone candidates ──
  const zoneCandidates = (analysis?.landingZones || []).map((z) => ({
    id: z.id,
    position: { x: z.x, y: z.y, z: z.z },
    radiusM: z.radius,
    score: z.score,
    classification: z.classification,
    patchAreaPx: z.patchAreaPx,
    minHazard: z.minHazard ?? z.min_hazard_in_patch,
    meanHazard: z.meanHazard ?? z.mean_hazard_in_patch,
    confidence: z.confidence,
    components: z.components,
    uncertainty: z.uncertainty || null,
  }));

  // ── Selected zone evidence ──
  const selectedZoneEvidence = selectedZone
    ? {
        id: selectedZone.id,
        position: { x: selectedZone.x, y: selectedZone.y, z: selectedZone.z },
        radiusM: selectedZone.radius,
        score: selectedZone.score,
        classification: selectedZone.classification,
        components: selectedZone.components,
        uncertainty: selectedZone.uncertainty || null,
        selectionRationale: classifyRationale(selectedZone),
      }
    : null;

  // ── Descent telemetry ──
  const descentTelemetry = landerState
    ? {
        startAltitudeM: 120,
        guidanceMode: landerState.guidanceMode || 'none',
        maxDescentRateMs: (landerState.maxDescentRate || 0).toFixed(2),
        fuelRemainingKg: (landerState.fuel || 0).toFixed(1),
        missionTimeS: (landerState.missionTime || 0).toFixed(2),
        impactSpeedMs: (landerState.impactSpeed || 0).toFixed(2),
        tiltAtTouchdownDeg: landerState.quat
          ? (Math.acos(Math.min(1, Math.abs(landerState.quat[0]))) * 2 * 180 / Math.PI).toFixed(1)
          : '0.0',
        angularRateDegS: landerState.wx != null
          ? (Math.sqrt((landerState.wx || 0) ** 2 + (landerState.wy || 0) ** 2 + (landerState.wz || 0) ** 2) * 180 / Math.PI).toFixed(1)
          : '0.0',
      }
    : null;

  // ── Touchdown assessment ──
  const touchdownAssessment = missionReport
    ? {
        outcome: missionReport.outcome,
        predictedClassification: missionReport.prediction?.classification || null,
        predictedScore: missionReport.prediction?.score || null,
        actualHazardPct: missionReport.actual?.hazard,
        actualTraversabilityPct: missionReport.actual?.traversability,
        assessment: missionReport.actual?.assessment,
      }
    : null;

  // ── Physics model ──
  const physicsModel = {
    type: '6DOF rigid body',
    gravity: 3.72,
    maxThrustAccel: 12.0,
    dryMassKg: 400,
    momentOfInertia: { Ixx: 120, Iyy: 100, Izz: 120 },
    attitudeControl: 'PID (Kp=8.0, Kd=4.0)',
    maxAngularRate: 0.5,
    safeLandingSpeed: 3.0,
    safeTiltAngleDeg: 20,
  };

  return {
    reportVersion: '2.0',
    timestamp,
    platform: 'BHUVAN Terrain Intelligence',
    terrainEvidence,
    methodology,
    zoneCandidates,
    selectedZone: selectedZoneEvidence,
    descentTelemetry,
    touchdownAssessment,
    physicsModel,
  };
}

function classifyRationale(zone) {
  if (!zone) return 'none';
  const parts = [];
  if (zone.classification === 'safe') parts.push('hazard-below-safe-threshold');
  if (zone.classification === 'caution') parts.push('hazard-below-caution-threshold');
  if ((zone.confidence || 0) > 0.7) parts.push('high-eroded-area-confidence');
  if ((zone.radius || 0) > 6) parts.push('adequate-inscribed-radius');
  if (zone.components) {
    if (zone.components.slope < 30) parts.push('low-slope-contribution');
    if (zone.components.shadow < 20) parts.push('low-shadow-contribution');
  }
  if (zone.uncertainty) {
    const ciWidth = zone.uncertainty.scoreCiUpper - zone.uncertainty.scoreCiLower;
    if (ciWidth < 15) parts.push('narrow-confidence-interval');
  }
  return parts.length > 0 ? parts.join('; ') : 'top-scored-candidate';
}

export function downloadReport(report) {
  const json = JSON.stringify(report, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bhuvan-mission-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
