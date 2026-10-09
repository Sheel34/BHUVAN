// Scientific coordinates use JS float64. GPU buffers remain float32.
// Reference sphere: USGS lunar interoperability convention, 1737.4 km.
// https://psdi.astrogeology.usgs.gov/moon/standards/data_standards/
export const MOON_REFERENCE = Object.freeze({ body: 'moon', radiusM: 1737400,
  frame: 'selenographic body-fixed; epoch/ME-vs-PA unspecified', longitude: 'east-positive' });

export function lunarBodyFixed(latDeg, lonDeg, heightM = 0, reference = MOON_REFERENCE) {
  if (reference.body !== 'moon' || !(reference.radiusM > 0)) throw new Error('A lunar reference radius is required.');
  if(![latDeg,lonDeg,heightM].every(Number.isFinite) || Math.abs(latDeg)>90 || reference.radiusM+heightM<=0)throw new Error('Invalid lunar latitude/longitude/height.');
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  const r = reference.radiusM + heightM;
  return new Float64Array([r * Math.cos(lat) * Math.cos(lon),
    r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)]);
}

// A future SPICE adapter can supply this basis/origin at a specified epoch.
// No ephemeris transform or ME/PA equivalence is claimed here.
export function createLocalFrame(origin, basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], reference = 'local') {
  const scientificOrigin = Float64Array.from(origin);
  const axes = basis.map(axis => Float64Array.from(axis));
  if (scientificOrigin.length !== 3 || !scientificOrigin.every(Number.isFinite) || axes.length !== 3
    || axes.some(a => a.length !== 3 || !a.every(Number.isFinite))
    || axes.some((a,k) => axes.some((b,j) => Math.abs(a.reduce((s,v,i)=>s+v*b[i],0) - (k===j ? 1 : 0)) > 1e-10))) {
    throw new Error('Local frame requires a finite origin and orthonormal basis.');
  }
  return {
    reference, get origin() {return Float64Array.from(scientificOrigin);},
    toLocal(position) {
      const delta = position.map((v, i) => v - scientificOrigin[i]);
      return Float64Array.from(axes, axis => axis.reduce((sum, v, i) => sum + v * delta[i], 0));
    },
    toScientific(local) {
      return Float64Array.from(scientificOrigin, (v, i) => v + axes.reduce((sum, axis, k) => sum + axis[i] * local[k], 0));
    },
  };
}

export function lunarLocalFrame(latDeg, lonDeg, heightM = 0) {
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  // Local x=east, y=up, z=north, independent of the globe's visual axes.
  return createLocalFrame(lunarBodyFixed(latDeg, lonDeg, heightM),
    [[-Math.sin(lon), Math.cos(lon), 0],
      [Math.cos(lat)*Math.cos(lon), Math.cos(lat)*Math.sin(lon), Math.sin(lat)],
      [-Math.sin(lat)*Math.cos(lon), -Math.sin(lat)*Math.sin(lon), Math.cos(lat)]], MOON_REFERENCE.frame);
}

export function cameraRelative(position, origin) {
  return Float32Array.from(position, (v, i) => v - origin[i]);
}

// Recentring this render adapter affects only LOCAL analytical coordinates.
// Registering body-fixed/inertial positions requires a separate authoritative
// frame transform; this adapter does not manufacture one.
export function createRenderFrame(localOrigin=[0,0,0]) {
  const validate=origin=> {if(origin.length!==3 || !Array.from(origin).every(Number.isFinite))throw new Error('Finite local render origin required.');};
  validate(localOrigin);
  let renderOrigin=Float64Array.from(localOrigin);
  return { get origin() {return Float64Array.from(renderOrigin);},
    setOrigin(origin) {validate(origin);renderOrigin=Float64Array.from(origin);},
    toRender(localAnalyticalPosition) {return cameraRelative(localAnalyticalPosition,renderOrigin);},
    toAnalytical(renderPosition) {return Float64Array.from(renderPosition,(v,i)=>v+renderOrigin[i]);},
  };
}

// This is a NUMERICAL float32 representation experiment. No WebGL, vertex
// shader, camera motion, rasterization or visual jitter is measured.
export function precisionBenchmark(separations = [1, .1, .01, .001]) {
  return [1, 1e3, 1e6, 1737400, 1e7, 1e8, 1e9, 1e12].flatMap(magnitude =>
    (Array.isArray(separations) ? separations : [separations]).map(separation => {
    if (!(separation > 0) || !Number.isFinite(separation)) throw new Error('Separation must be positive and finite.');
    const represented = magnitude + separation;
    const global = Math.fround(represented) - Math.fround(magnitude);
    const relative = cameraRelative([represented], [magnitude])[0];
    return { kind: 'numerical precision benchmark only', gpuJitterMeasured: false,
      magnitude, expectedSeparation: separation, globalSeparation: global,
      globalError: Math.abs(global-separation), relativeSeparation: relative,
      relativeError: Math.abs(relative-separation), // legacy absolute-error key
      absoluteFloat32: { representedSeparation: global, absoluteError: Math.abs(global-separation), relativeError: Math.abs(global-separation)/separation },
      originFirstFloat32: { representedSeparation: relative, absoluteError: Math.abs(relative-separation), relativeError: Math.abs(relative-separation)/separation },
      cpuError: Math.abs((represented-magnitude)-separation) };
  }));
}

// Raster row/column coordinates are distinct from ENU/body-fixed positions.
// The existing visual axes are x=row (south), y=up, z=column (east).
// AEQD/projected coordinates are not silently treated as a tangent ENU frame.
export function datasetCoordinateContext(provenance, terrain) {
  const sourceModel=provenance.reference_model;
  const radiusM = sourceModel ? sourceModel.radius_m ?? (sourceModel.a_m===sourceModel.b_m ? sourceModel.a_m : null)
    : provenance.body === 'moon' ? MOON_REFERENCE.radiusM : null;
  const extentM = provenance.metric ? terrain.scale : null;
  return {
    scientific: { precision: 'CPU float64', body: provenance.body, reference: provenance.reference,
      verticalReference: provenance.vertical_reference, referenceModel: provenance.reference_model ?? null,
      latitude: provenance.origin_lat ?? null, longitude: provenance.origin_lon ?? null,
      horizontalUnit:provenance.horizontal_unit ?? 'source reference units; unspecified',
      rasterToReference:provenance.affine ? ([row,column,elevation])=> {
        const [a,b,c,d,e,f]=provenance.affine;
        return new Float64Array([a*(column+.5)+b*(row+.5)+c,d*(column+.5)+e*(row+.5)+f,elevation]);
      } : null },
    analytical: { frame: provenance.local_frame ?? 'dataset-local projected patch', extentM,
      gsd: provenance.analysis_gsd, origin: 'patch centre; elevations retain source datum',
      rasterToLocalEastNorthUp: ([x,y,z]) => new Float64Array([z,-x,y]) },
    render: { precision: 'GPU float32', placement: 'separate local scene near origin',
      elevationOrigin: terrain.elevationOrigin, continuousFloatingOrigin: false,
      frame: createRenderFrame([0,terrain.elevationOrigin,0]),
      inputCoordinates: 'local analytical raster axes; not body-fixed/global positions' },
    // Maximum spherical tangent-plane departure at a square patch corner.
    curvatureApproximationM: radiusM && extentM ? radiusM*(1-Math.cos(extentM/Math.SQRT2/radiusM)) : null,
    frameTransforms: { inertialAvailable: false, required: 'time, frame definitions and authoritative transform provider (e.g. SPICE)' },
  };
}
