// Dimensions/speed describe the published vehicles. Traversal limits below
// are editable experiment assumptions, not flight-qualified operating limits.
export const VEHICLE_PROFILES = Object.freeze({
  generic: {id:'generic',name:'Engineering rover',width:2.3,track:2,wheelbase:1.7,speed:1,science:'Terrain inspection',task:'Document terrain and unresolved obstacles',asset:null},
  curiosity: {id:'curiosity',name:'Curiosity',width:2.7,track:2.3,wheelbase:2.2,speed:.02,science:'Mastcam · ChemCam · SAM · CheMin',task:'Plan a contextual imaging and rock-composition observation',asset:'/models/curiosity.glb',source:'https://science.nasa.gov/mission/msl-curiosity/'},
  perseverance: {id:'perseverance',name:'Perseverance',width:2.7,track:2.3,wheelbase:2.2,speed:.02,science:'Mastcam-Z · SuperCam · SHERLOC · PIXL · sample caching',task:'Plan stereo imaging and a candidate sample-cache observation',asset:'/models/perseverance.glb',source:'https://science.nasa.gov/mission/mars-2020-perseverance/rover-components/'},
});
export const vehicleProfile = id => VEHICLE_PROFILES[id] || VEHICLE_PROFILES.generic;
export const vehicleWheels = id => {
  const p=vehicleProfile(id);
  return [-p.track/2,p.track/2].flatMap(x=>[-p.wheelbase/2,0,p.wheelbase/2].map(z=>[x,z]));
};
