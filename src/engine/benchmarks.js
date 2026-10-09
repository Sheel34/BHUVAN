import { precisionBenchmark } from './coordinates';
import { MemoryTileSource, terrainTiles, RemoteTileSource } from './tileSource';

// Measured bounded-window access versus copying a resident monolithic raster.
// Does not pretend to benchmark a COG server or GPU frame time.
export async function runDataBenchmark(terrain) {
  if(terrain.stream) {
    const source=new RemoteTileSource(terrain.stream,{maxTiles:4}),start=performance.now();
    const level=Math.max(0,terrain.stream.max_level-2),count=Math.ceil((terrain.size-1)/(128*2**level));
    try {
      for(let x=0;x<count;x++)await source.getTile(level,x,0);
      return {kind:'measured network tile access; numerical precision benchmark only; GPU frame timing sampled separately',
        totalMs:performance.now()-start,...source.statistics,precision:precisionBenchmark()};
    } finally {source.dispose();}
  }
  const begin = performance.now();
  const monolithic = Float64Array.from(terrain.scientificData || terrain.data);
  const monolithicMs = performance.now()-begin;
  const source = new MemoryTileSource(terrain);
  let peakWindowBytes = 0;
  const tileBegin = performance.now();
  for (const tile of terrainTiles(terrain.size)) {
    const window = await source.readTile(tile);
    peakWindowBytes = Math.max(peakWindowBytes, window.fields.height.byteLength);
  }
  return { kind: 'resident CPU access; GPU frame timing sampled separately', size: terrain.size,
    monolithicMs, monolithicBytes: monolithic.byteLength,
    tiledMs: performance.now()-tileBegin, tileCount: source.metrics.reads,
    peakWindowBytes, precision: precisionBenchmark() };
}

// DEV-only callers supply the real backend URL. No N*N raster or geometry is
// created here; actual renderer frame timing is recorded by PerfStats.
export async function runStreamingSizeBenchmark(apiBase) {
  const results=[];
  for(const size of [512,1024,2048,4096,8192,16384,32768]) {
    const response=await fetch(`${apiBase}/api/v1/terrain/datasets/benchmark-${size}`);
    if(!response.ok)throw new Error('Development streaming datasets unavailable (enable BHUVAN_DEV_BENCHMARKS=1 on the development server).');
    const d=await response.json();d.tile_url=apiBase+d.tile_url;d.point_url=apiBase+d.point_url;
    const source=new RemoteTileSource(d,{maxTiles:8,maxBytes:2*1024*1024});
    const start=performance.now();let initialLoadMs;
    try {
      await source.getTile(0,0,0);initialLoadMs=performance.now()-start;
      const count=Math.ceil((size-1)/128);
      for(let k=0;k<Math.min(24,count**2);k++)await source.getTile(0,k%count,Math.floor(k/count));
      results.push({status:'SYNTHETIC logical source; evaluated per tile',size,initialLoadMs,
        elapsedMs:performance.now()-start,...source.statistics,fullRasterAllocated:false,
        browserHeapBytes:performance.memory?.usedJSHeapSize ?? null,averageFrameMs:null});
    } finally {source.dispose();}
  }
  return {kind:'network working-set benchmark; frame time not measured by this experiment',results};
}
