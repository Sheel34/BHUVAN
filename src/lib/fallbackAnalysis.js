import { createAnalysisFromTerrain, generateTerrain } from '../engine/terrain';

const SAMPLE_CONFIGS = {
  'mars-jezero': { name: 'Jezero Analogue', seed: 42, scale: 200, heightScale: 28 },
  'moon-south-pole': { name: 'South Pole Analogue', seed: 87, scale: 200, heightScale: 32 },
  'mars-gale': { name: 'Gale Crater Analogue', seed: 133, scale: 200, heightScale: 26 },
};

export function getFallbackSamples() {
  return Object.entries(SAMPLE_CONFIGS).map(([id, config]) => ({
    id,
    label: config.name,
    source: 'frontend-fallback',
  }));
}

export function analyzeFallbackSample(sampleId = 'mars-jezero') {
  const config = SAMPLE_CONFIGS[sampleId] || SAMPLE_CONFIGS['mars-jezero'];
  const terrain = generateTerrain(160, config.scale, config.heightScale, config.seed);
  const analysis = createAnalysisFromTerrain(terrain, config.name);
  return {
    ...analysis,
    metadata: {
      ...analysis.metadata,
      source: 'frontend-fallback',
      disclaimer: 'Backend unavailable. Showing deterministic demo terrain so the interface remains usable.',
    },
  };
}
