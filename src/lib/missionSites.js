// Lunar surface mission atlas — every craft humans have put on the Moon,
// at its real selenographic coordinates. Facts are mission-record level:
// agency, date, transit time, outcome, what it found, the story, and the
// controversy where one exists. Rendered as markers on the globe; click
// opens a dossier. No fluff, no emoji — instrument-grade.

export const MISSION_SITES = [
  // ── Soviet firsts ───────────────────────────────────────────────
  {
    id: 'luna-2', name: 'Luna 2', agency: 'OKB-1', country: 'USSR',
    lat: 29.1, lon: 0.0, date: '1959-09-13', type: 'impactor', outcome: 'impact',
    transit: '33.5 hours',
    summary: 'First human-made object to reach another celestial body.',
    discovery: 'Confirmed the Moon has no appreciable magnetic field or radiation belt.',
    story: 'Slammed into the surface near Mare Imbrium at ~3.3 km/s, scattering Soviet pennants. Launched two years before any crewed flight.',
    controversy: 'Western observers demanded independent confirmation; Jodrell Bank in the UK tracked it to verify the Soviet claim.',
  },
  {
    id: 'luna-9', name: 'Luna 9', agency: 'Lavochkin', country: 'USSR',
    lat: 7.08, lon: -64.37, date: '1966-02-03', type: 'lander', outcome: 'success',
    transit: '3 days 4 hours',
    summary: 'First survivable soft landing and first photos from the lunar surface.',
    discovery: 'Proved the regolith was firm enough to bear a lander — settling the "spacecraft will sink into dust" fear before Apollo.',
    story: 'A 58 cm sphere that ejected and righted itself with petal panels in Oceanus Procellarum.',
    controversy: 'Jodrell Bank intercepted the facsimile image signal and published the first surface pictures before the USSR did — using a newspaper fax machine.',
  },
  {
    id: 'luna-16', name: 'Luna 16', agency: 'Lavochkin', country: 'USSR',
    lat: -0.51, lon: 56.36, date: '1970-09-20', type: 'sample-return', outcome: 'success',
    transit: '4 days 13 hours',
    summary: 'First robotic sample return from another world.',
    discovery: 'Returned 101 g of Mare Fecunditatis regolith — proof a robot could do what Apollo did, far cheaper.',
    story: 'Drilled, sealed, and rocketed the sample straight back to a capsule that parachuted into Kazakhstan.',
    controversy: 'Reframed the Space Race: critics argued robotic sample return made crewed landings politically, not scientifically, motivated.',
  },
  {
    id: 'lunokhod-1', name: 'Luna 17 · Lunokhod 1', agency: 'Lavochkin', country: 'USSR',
    lat: 38.28, lon: -34.99, date: '1970-11-17', type: 'rover', outcome: 'success',
    transit: '4 days 12 hours',
    summary: 'First wheeled vehicle to operate on another world.',
    discovery: 'Drove 10.5 km over 11 lunar days, returning 20,000+ images and soil mechanics data.',
    story: 'Driven in near-real-time by a five-person crew on Earth fighting 2.5 s signal lag and the lunar night.',
    controversy: 'Its exact resting place was lost for decades until LRO imaged it in 2010; its retroreflector is still ranged by lasers today.',
  },
  {
    id: 'lunokhod-2', name: 'Luna 21 · Lunokhod 2', agency: 'Lavochkin', country: 'USSR',
    lat: 25.85, lon: 30.45, date: '1973-01-15', type: 'rover', outcome: 'success',
    transit: '4 days 11 hours',
    summary: 'Held the off-world driving distance record for ~40 years.',
    discovery: 'Covered ~39 km in the Le Monnier crater, only beaten by Opportunity (Mars, 2014).',
    story: 'Died when it rolled into a crater, kicked lunar soil onto its radiator, and overheated.',
    controversy: 'Sold at a 1993 Sotheby’s auction for $68,500 while sitting on the Moon — arguably the most remote real-estate sale ever.',
  },

  // ── United States ───────────────────────────────────────────────
  {
    id: 'surveyor-1', name: 'Surveyor 1', agency: 'NASA / JPL', country: 'USA',
    lat: -2.47, lon: -43.34, date: '1966-06-02', type: 'lander', outcome: 'success',
    transit: '2 days 15 hours',
    summary: 'First US soft landing — four months after Luna 9.',
    discovery: 'Returned 11,000+ images and confirmed bearing strength for the Apollo landers.',
    story: 'Survived the lunar night repeatedly and operated far past its design life.',
    controversy: null,
  },
  {
    id: 'apollo-11', name: 'Apollo 11', agency: 'NASA', country: 'USA',
    lat: 0.674, lon: 23.473, date: '1969-07-20', type: 'crewed', outcome: 'success',
    crew: 'Armstrong, Aldrin (Collins in orbit)', transit: '4 days 6 hours',
    summary: 'First crewed landing. Humans walk on another world.',
    discovery: 'Returned 21.5 kg of samples; deployed the first seismometer and laser retroreflector.',
    story: 'The guidance computer threw 1202 alarms during descent; Armstrong flew manually past a boulder field with ~25 s of fuel left.',
    controversy: 'Target of persistent hoax claims — refuted by retroreflector ranging, LRO imagery of the hardware, and returned samples studied worldwide.',
  },
  {
    id: 'apollo-12', name: 'Apollo 12', agency: 'NASA', country: 'USA',
    lat: -3.01, lon: -23.42, date: '1969-11-19', type: 'crewed', outcome: 'success',
    crew: 'Conrad, Bean (Gordon in orbit)', transit: '4 days 14 hours',
    summary: 'Pinpoint landing — touched down 160 m from Surveyor 3.',
    discovery: 'Crew cut parts off Surveyor 3 and returned them, revealing how hardware ages in 2.5 years on the surface.',
    story: 'Lightning struck the Saturn V twice in the first minute of launch; a flight controller’s "SCE to AUX" call saved the mission.',
    controversy: null,
  },
  {
    id: 'apollo-15', name: 'Apollo 15', agency: 'NASA', country: 'USA',
    lat: 26.13, lon: 3.63, date: '1971-07-30', type: 'crewed', outcome: 'success',
    crew: 'Scott, Irwin (Worden in orbit)', transit: '4 days 6 hours',
    summary: 'First Lunar Roving Vehicle — range geology begins.',
    discovery: 'Collected the "Genesis Rock," an anorthosite fragment of the Moon’s primordial crust.',
    story: 'Scott dropped a hammer and a feather on live TV; they hit the ground together, confirming Galileo on the Moon.',
    controversy: 'The crew carried ~400 unauthorized postal covers to sell; the resulting scandal ended their flight careers.',
  },
  {
    id: 'apollo-17', name: 'Apollo 17', agency: 'NASA', country: 'USA',
    lat: 20.19, lon: 30.77, date: '1972-12-11', type: 'crewed', outcome: 'success',
    crew: 'Cernan, Schmitt (Evans in orbit)', transit: '4 days 14 hours',
    summary: 'Last time humans stood on the Moon. First geologist on the surface.',
    discovery: 'Schmitt found orange volcanic glass — tiny beads from explosive eruptions 3.6 billion years ago.',
    story: 'Cernan’s last words from the surface: a promise to return "not too long into the future" — unkept for over 50 years.',
    controversy: 'The "Blue Marble" photo of the full Earth was taken on the way out; authorship is still disputed among the crew.',
  },

  // ── China ───────────────────────────────────────────────────────
  {
    id: 'change-3', name: "Chang'e 3 · Yutu", agency: 'CNSA', country: 'China',
    lat: 44.12, lon: -19.51, date: '2013-12-14', type: 'rover', outcome: 'success',
    transit: '4 days 12 hours',
    summary: 'First soft landing since Luna 24 (1976) — ended a 37-year gap.',
    discovery: 'Ground-penetrating radar revealed at least nine distinct subsurface basalt layers in Mare Imbrium.',
    story: 'The Yutu ("Jade Rabbit") rover suffered a control fault but kept transmitting science as a stationary station.',
    controversy: 'State media briefly wrote a first-person "farewell" for Yutu, then it unexpectedly woke up — a viral moment.',
  },
  {
    id: 'change-4', name: "Chang'e 4 · Yutu-2", agency: 'CNSA', country: 'China',
    lat: -45.44, lon: 177.6, date: '2019-01-03', type: 'rover', outcome: 'success',
    transit: '4 days 16 hours',
    summary: 'First landing on the lunar far side.',
    discovery: 'Sampled mantle-derived material in Von Kármán crater; grew the first plant (cotton) sprout on the Moon.',
    story: 'Impossible to contact directly from Earth — it works through the Queqiao relay satellite parked beyond the Moon.',
    controversy: 'Far-side secrecy fueled speculation; China released imagery slowly, drawing both praise and suspicion.',
  },
  {
    id: 'change-5', name: "Chang'e 5", agency: 'CNSA', country: 'China',
    lat: 43.06, lon: -51.92, date: '2020-12-01', type: 'sample-return', outcome: 'success',
    transit: '4 days 13 hours',
    summary: 'First lunar samples returned by anyone since 1976.',
    discovery: 'Its 1,731 g of basalt proved volcanism continued to ~2 billion years ago — far later than models predicted.',
    story: 'Performed the first robotic lunar-orbit rendezvous and docking to hand off the sample for the trip home.',
    controversy: null,
  },
  {
    id: 'change-6', name: "Chang'e 6", agency: 'CNSA', country: 'China',
    lat: -41.64, lon: -153.99, date: '2024-06-01', type: 'sample-return', outcome: 'success',
    transit: '4 days 20 hours',
    summary: 'First samples ever returned from the lunar far side.',
    discovery: 'Returned 1,935 g from the South Pole–Aitken basin — the oldest, deepest impact structure on the Moon.',
    story: 'Landed in the solar system’s largest known crater to sample excavated mantle material.',
    controversy: 'Western labs sought access to the samples amid US legislation restricting NASA–CNSA cooperation.',
  },

  // ── India ───────────────────────────────────────────────────────
  {
    id: 'chandrayaan-2', name: 'Chandrayaan-2 · Vikram', agency: 'ISRO', country: 'India',
    lat: -70.88, lon: 22.78, date: '2019-09-06', type: 'lander', outcome: 'crash',
    transit: '48 days',
    summary: 'Crashed during the final descent to the south-polar region.',
    discovery: 'The orbiter survived and still maps water-ice signatures and surface chemistry today.',
    story: 'Telemetry was lost at 2.1 km altitude after a braking-thruster overcorrection; the lander broke apart on impact.',
    controversy: 'ISRO did not immediately confirm the crash; a NASA-credited amateur, Shanmuga Subramanian, first located the debris in LRO images.',
  },
  {
    id: 'chandrayaan-3', name: 'Chandrayaan-3 · Vikram', agency: 'ISRO', country: 'India',
    lat: -69.37, lon: 32.32, date: '2023-08-23', type: 'rover', outcome: 'success',
    transit: '40 days',
    summary: 'First soft landing near the lunar south pole. India becomes the 4th nation to land.',
    discovery: 'Pragyan confirmed sulphur in the regolith in-situ and measured the steep polar day-night temperature gradient.',
    story: 'Reached the Moon on a slow, fuel-thrifty Earth-orbit-raising trajectory; the touchdown site is named Shiv Shakti Point.',
    controversy: 'Landed days after Russia’s Luna 25 crashed nearby attempting the same region — an unplanned, very public race.',
  },

  // ── Japan / Israel ──────────────────────────────────────────────
  {
    id: 'slim', name: 'SLIM', agency: 'JAXA', country: 'Japan',
    lat: -13.31, lon: 25.25, date: '2024-01-19', type: 'lander', outcome: 'success',
    transit: '4 months (slow transfer)',
    summary: 'The "Moon Sniper" — landed within ~55 m of its target.',
    discovery: 'Demonstrated pinpoint vision-based navigation, a key for future precise polar landings.',
    story: 'A late engine anomaly tipped it nose-down, but it still returned science and survived multiple lunar nights it was never designed for.',
    controversy: 'Its solar cells faced the wrong way at first; survival was initially declared unlikely, then it kept reviving.',
  },
  {
    id: 'beresheet', name: 'Beresheet', agency: 'SpaceIL', country: 'Israel',
    lat: 32.6, lon: 19.3, date: '2019-04-11', type: 'lander', outcome: 'crash',
    transit: '48 days',
    summary: 'First privately funded Moon landing attempt; crashed on descent.',
    discovery: 'Proved a small, low-cost team could reach lunar descent — reshaping commercial lunar ambitions.',
    story: 'A gyroscope failure cascaded into a main-engine cutoff; it struck Mare Serenitatis at high speed.',
    controversy: 'It carried thousands of dehydrated tardigrades, raising serious planetary-contamination and ethics debates after the crash.',
  },
];

// Marker tint by outcome — semantic but muted to fit the steel theme.
export const OUTCOME_COLOR = {
  success: '#9fb0cf',
  crash: '#d98a76',
  impact: '#cdb083',
};
