// Real lunar surface missions — landers, rovers, crewed landings, sample
// returns, and impacts. Coordinates are the actual touchdown/impact sites
// (selenographic lat/lon, +E). Facts are historical and verifiable.
//
// `sampleId` links a mission to an analyzable terrain sample where one
// exists, so a dossier can launch the survey workspace for that site.
//
// type: crewed | rover | lander | sample-return | impact | crash
// status: success | partial | failed

export const LUNAR_MISSIONS = [
  // ── United States — Apollo (crewed) ──
  {
    id: 'apollo-11', mission: 'Apollo 11', agency: 'NASA', country: 'USA',
    type: 'crewed', status: 'success', lat: 0.674, lon: 23.473,
    date: '1969-07-20', transit: '4 days 6 h', crew: 'Armstrong · Aldrin · Collins',
    site: 'Mare Tranquillitatis', sampleId: 'moon-mare-tranquillitatis',
    summary: 'First humans on another world. Armstrong and Aldrin spent 21h 36m on the surface; 2h 31m walking.',
    discoveries: [
      'Returned 21.5 kg of basaltic regolith — older than most Earth rocks (3.7 Gyr).',
      'Deployed the first passive seismometer and laser retroreflector (still ranged today).',
      'Confirmed the surface bears human weight — settling fears of deep dust burial.',
    ],
    how: 'Lunar Module Eagle separated from Columbia and descended on a single throttleable engine; Armstrong manually flew past a boulder field to a smooth mare site with ~25 s of fuel left.',
    facts: [
      'The descent computer threw 1202/1201 alarms — overloaded but non-fatal; the landing continued.',
      'The retroreflector still measures the Earth–Moon distance to millimetre precision.',
    ],
    controversy: 'Moon-hoax conspiracy theories persist; NASA\'s own Lunar Reconnaissance Orbiter has since photographed the descent stage and footpaths from orbit, settling it.',
  },
  {
    id: 'apollo-15', mission: 'Apollo 15', agency: 'NASA', country: 'USA',
    type: 'crewed', status: 'success', lat: 26.132, lon: 3.633,
    date: '1971-07-30', transit: '4 days 1 h', crew: 'Scott · Irwin · Worden',
    site: 'Hadley–Apennine',
    summary: 'First mission with the Lunar Roving Vehicle — extended traverses turned astronauts into field geologists.',
    discoveries: [
      'Found the "Genesis Rock", an anorthosite ~4.1 Gyr old — a piece of the primordial crust.',
      'First use of the LRV: 27.8 km driven across the Hadley Rille region.',
    ],
    how: 'The electric LRV let the crew range kilometres from the lander, sampling the Apennine front and a lava channel.',
    facts: ['Scott dropped a hammer and a feather together on camera — they hit the dust at the same instant.'],
    controversy: 'The crew carried unauthorised commemorative postal covers; the resulting "stamp scandal" ended their flying careers.',
  },
  {
    id: 'apollo-17', mission: 'Apollo 17', agency: 'NASA', country: 'USA',
    type: 'crewed', status: 'success', lat: 20.191, lon: 30.772,
    date: '1972-12-11', transit: '3 days 14 h', crew: 'Cernan · Schmitt · Evans',
    site: 'Taurus–Littrow',
    summary: 'The last crewed landing — and the only one to carry a trained geologist, Harrison Schmitt.',
    discoveries: [
      'Discovered orange volcanic glass — tiny beads from fire-fountain eruptions ~3.6 Gyr ago.',
      'Heaviest sample haul of the programme: 110.5 kg.',
    ],
    how: 'Three days of LRV traverses across a deep valley flanked by mountains taller than the Grand Canyon is deep.',
    facts: ['Cernan\'s last footprints remain undisturbed; no human has returned in over 50 years.'],
    controversy: null,
  },

  // ── USSR — Luna programme ──
  {
    id: 'luna-2', mission: 'Luna 2', agency: 'OKB-1', country: 'USSR',
    type: 'impact', status: 'success', lat: 29.1, lon: 0.0,
    date: '1959-09-13', transit: '34 h', crew: 'Robotic',
    site: 'Palus Putredinis',
    summary: 'First human-made object to reach another celestial body — a deliberate hard impact.',
    discoveries: ['Measured no detectable lunar magnetic field or radiation belt during approach.'],
    how: 'A direct ballistic trajectory; no braking — it struck the surface at ~3.3 km/s.',
    facts: ['Scattered titanium pennants engraved with the Soviet coat of arms across the impact site.'],
    controversy: 'Timed to land during Khrushchev\'s US visit as a Cold-War statement.',
  },
  {
    id: 'luna-9', mission: 'Luna 9', agency: 'OKB-1', country: 'USSR',
    type: 'lander', status: 'success', lat: 7.08, lon: -64.37,
    date: '1966-02-03', transit: '3 days 4 h', crew: 'Robotic',
    site: 'Oceanus Procellarum',
    summary: 'First soft landing on the Moon and first images from the surface of another world.',
    discoveries: ['Proved the surface was solid enough to support a lander — ending the "deep dust ocean" fear.'],
    how: 'An airbag-cushioned capsule was ejected just before impact and bounced to rest.',
    facts: ['Jodrell Bank in the UK intercepted the image signal and published the photos before the USSR did.'],
    controversy: 'The intercepted-and-scooped images embarrassed the Soviet programme.',
  },
  {
    id: 'luna-17', mission: 'Luna 17 · Lunokhod 1', agency: 'Lavochkin', country: 'USSR',
    type: 'rover', status: 'success', lat: 38.28, lon: -35.0,
    date: '1970-11-17', transit: '4 days 12 h', crew: 'Robotic rover',
    site: 'Mare Imbrium',
    summary: 'First wheeled vehicle to operate on another world — remotely driven from Earth.',
    discoveries: ['Drove 10.5 km over 10 months, returning 20,000+ images and 500+ soil tests.'],
    how: 'A five-person team on Earth drove it blind through 2.5 s round-trip signal lag, one frame at a time.',
    facts: ['Its retroreflector was "lost" for 40 years until LRO imagery let it be ranged again in 2010.'],
    controversy: null,
  },
  {
    id: 'luna-21', mission: 'Luna 21 · Lunokhod 2', agency: 'Lavochkin', country: 'USSR',
    type: 'rover', status: 'success', lat: 25.85, lon: 30.45,
    date: '1973-01-15', transit: '4 days 13 h', crew: 'Robotic rover',
    site: 'Le Monnier crater',
    summary: 'Held the off-world driving-distance record for decades.',
    discoveries: ['Covered ~39 km — a record unbeaten until NASA\'s Opportunity rover on Mars in 2014.'],
    how: 'Faster driving than Lunokhod 1, with an improved TV system for the Earth-side drivers.',
    facts: ['Died after its open lid scooped lunar soil onto the radiator, causing it to overheat.'],
    controversy: null,
  },
  {
    id: 'luna-16', mission: 'Luna 16', agency: 'Lavochkin', country: 'USSR',
    type: 'sample-return', status: 'success', lat: -0.68, lon: 56.30,
    date: '1970-09-20', transit: '4 days 11 h', crew: 'Robotic',
    site: 'Mare Fecunditatis',
    summary: 'First fully robotic sample return — no humans, no rover, just a drill and a rocket home.',
    discoveries: ['Returned 101 g of soil, proving automated sample return was possible.'],
    how: 'A drill bored 35 cm, sealed the core in an ascent capsule, and launched it straight back to Earth.',
    facts: ['Demonstrated the USSR could get Moon rocks without risking cosmonauts.'],
    controversy: null,
  },

  // ── China — Chang\'e ──
  {
    id: 'change-3', mission: "Chang'e 3 · Yutu", agency: 'CNSA', country: 'China',
    type: 'rover', status: 'partial', lat: 44.12, lon: -19.51,
    date: '2013-12-14', transit: '4 days 16 h', crew: 'Robotic rover',
    site: 'Mare Imbrium',
    summary: 'First soft landing on the Moon in 37 years, and China\'s first.',
    discoveries: ['Ground-penetrating radar revealed at least nine distinct subsurface basalt layers.'],
    how: 'A hovering, hazard-avoiding descent — the lander scanned for boulders before touchdown.',
    facts: ['The Yutu rover suffered a mechanical fault but kept transmitting science as a stationary station.'],
    controversy: null,
  },
  {
    id: 'change-4', mission: "Chang'e 4 · Yutu-2", agency: 'CNSA', country: 'China',
    type: 'rover', status: 'success', lat: -45.44, lon: 177.60,
    date: '2019-01-03', transit: '4 days 12 h', crew: 'Robotic rover',
    site: 'Von Kármán crater (far side)',
    summary: 'First-ever soft landing on the far side of the Moon — the side never visible from Earth.',
    discoveries: ['Sampled mantle-derived material in the South Pole–Aitken basin; sprouted the first plant (cotton) on the Moon.'],
    how: 'Impossible to control directly from Earth — a dedicated relay satellite, Queqiao, was parked beyond the Moon first.',
    facts: ['Yutu-2 is the longest-lived lunar rover ever, still operating years past its design life.'],
    controversy: null,
  },
  {
    id: 'change-6', mission: "Chang'e 6", agency: 'CNSA', country: 'China',
    type: 'sample-return', status: 'success', lat: -41.6, lon: -153.9,
    date: '2024-06-02', transit: '~4 days', crew: 'Robotic',
    site: 'Apollo basin (far side)',
    summary: 'First sample return from the far side of the Moon.',
    discoveries: ['Returned 1,935 g of far-side material — chemically distinct from all near-side samples.'],
    how: 'Relay-assisted landing, drill + scoop, ascent to lunar orbit, rendezvous, and return to Earth.',
    facts: ['The far side crust is thicker and the samples help explain the Moon\'s lopsided two-faced geology.'],
    controversy: 'Some nations raised access-and-sharing questions over far-side sample custody.',
  },

  // ── India — Chandrayaan ──
  {
    id: 'chandrayaan-3', mission: 'Chandrayaan-3 · Vikram', agency: 'ISRO', country: 'India',
    type: 'lander', status: 'success', lat: -69.37, lon: 32.32,
    date: '2023-08-23', transit: '40 days', crew: 'Vikram lander · Pragyan rover',
    site: 'Near south pole (Shiv Shakti Point)', sampleId: 'moon-shackleton',
    summary: 'First soft landing near the lunar south pole — and India the 4th nation ever to land on the Moon.',
    discoveries: [
      'Pragyan confirmed sulphur in the regolith in situ — relevant to in-place resource use.',
      'Measured the first near-surface temperature profile at high lunar latitude.',
    ],
    how: 'A fuel-efficient 40-day spiral of Earth orbit-raising burns, then a hazard-avoiding autonomous descent — flying long after the spot where Chandrayaan-2 was lost.',
    facts: ['Cost roughly USD 75 million — less than many space films\' budgets.'],
    controversy: null,
  },
  {
    id: 'chandrayaan-2', mission: 'Chandrayaan-2 · Vikram', agency: 'ISRO', country: 'India',
    type: 'crash', status: 'failed', lat: -70.88, lon: 22.78,
    date: '2019-09-06', transit: '48 days', crew: 'Vikram lander (lost)',
    site: 'Near south pole',
    summary: 'A near-miss that became the motivation for this kind of terrain-hazard tool.',
    discoveries: ['The orbiter survived and still maps water-ice and mineralogy from lunar orbit today.'],
    how: 'During braking the lander deviated from its trajectory and contact was lost at ~2.1 km altitude.',
    facts: ['NASA\'s LRO and a citizen analyst later located the impact debris field.'],
    controversy: 'ISRO initially withheld the failure analysis; the loss directly inspired Chandrayaan-3\'s redundant hazard-avoidance design.',
  },

  // ── Japan ──
  {
    id: 'slim', mission: 'SLIM', agency: 'JAXA', country: 'Japan',
    type: 'lander', status: 'partial', lat: -13.32, lon: 25.25,
    date: '2024-01-19', transit: '~4 months', crew: 'Robotic',
    site: 'Shioli crater',
    summary: '"Moon Sniper" — a precision-landing demonstrator that hit within 100 m of its target.',
    discoveries: ['Proved pinpoint (sub-100 m) landing using crater-matching vision navigation.'],
    how: 'Onboard cameras matched craters to an orbital map in real time to steer to an exact spot.',
    facts: ['It tipped onto its nose at touchdown yet still did its science once the Sun hit its panels.'],
    controversy: null,
  },

  // ── Israel (private) ──
  {
    id: 'beresheet', mission: 'Beresheet', agency: 'SpaceIL', country: 'Israel',
    type: 'crash', status: 'failed', lat: 32.6, lon: 19.3,
    date: '2019-04-11', transit: '48 days', crew: 'Robotic',
    site: 'Mare Serenitatis',
    summary: 'First privately funded mission to attempt a lunar landing.',
    discoveries: ['Demonstrated a low-cost path to the Moon for a non-government team.'],
    how: 'A small budget forced a long, looping, fuel-saving trajectory before the final descent.',
    facts: ['An engine glitch during braking caused the crash.'],
    controversy: 'Its payload carried tardigrades, raising debate about contaminating the Moon with Earth life.',
  },
];

// Marker styling per mission type — calm, serious, semantic.
export const MISSION_TYPE_STYLE = {
  crewed: { color: '#e8c97a', label: 'Crewed landing' },
  rover: { color: '#9ad0c2', label: 'Rover' },
  lander: { color: '#c9d2e0', label: 'Lander' },
  'sample-return': { color: '#b9a7e0', label: 'Sample return' },
  impact: { color: '#d98a6a', label: 'Impact' },
  crash: { color: '#e06a6a', label: 'Crash site' },
};

export function missionsWithSurvey() {
  return LUNAR_MISSIONS.filter((m) => m.sampleId);
}
