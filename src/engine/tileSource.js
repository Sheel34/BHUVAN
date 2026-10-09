// A TileSource owns scientific samples, not Three.js objects. readTile returns
// a bounded window with a one-cell halo, independently of other tile requests.
export const TILE_CELLS = 128;

export function terrainTiles(size) {
  const tiles = [];
  for (let i = 0; i < size-1; i += TILE_CELLS) for (let j = 0; j < size-1; j += TILE_CELLS) {
    tiles.push({ i0: i, i1: Math.min(i+TILE_CELLS, size-1), j0: j,
      j1: Math.min(j+TILE_CELLS, size-1), key: `${i}:${j}` });
  }
  return tiles;
}

export class MemoryTileSource {
  constructor(terrain, layers = {}) {
    this.terrain = terrain;
    this.layers = layers;
    this.metrics = { reads: 0, bytes: 0, totalLoadMs: 0 };
    this.limitation = 'Full source raster resident in browser RAM; only GPU working set is bounded.';
  }
  async readTile(tile, { signal } = {}) {
    signal?.throwIfAborted();
    const start = performance.now(), { size, data } = this.terrain;
    if (!Number.isInteger(tile.i0) || !Number.isInteger(tile.i1) || !Number.isInteger(tile.j0) || !Number.isInteger(tile.j1)
      || tile.i0 < 0 || tile.j0 < 0 || tile.i1 >= size || tile.j1 >= size || tile.i1 <= tile.i0 || tile.j1 <= tile.j0) {
      throw new Error('Tile window lies outside the dataset or is empty.');
    }
    const i0 = Math.max(0, tile.i0-1), j0 = Math.max(0, tile.j0-1);
    const i1 = Math.min(size-1, tile.i1+1), j1 = Math.min(size-1, tile.j1+1);
    const rows = i1-i0+1, cols = j1-j0+1;
    const fields = { height: new Float64Array(rows*cols) };
    for (const name of Object.keys(this.layers)) if (this.layers[name]?.length === size*size) fields[name] = new Float32Array(rows*cols);
    for (let i=i0; i<=i1; i++) for (let j=j0; j<=j1; j++) {
      const k=(i-i0)*cols+j-j0, index=i*size+j;
      fields.height[k]=data[index];
      for (const name of Object.keys(fields)) if (name !== 'height') fields[name][k]=this.layers[name][index];
    }
    this.metrics.reads++;
    this.metrics.bytes += Object.values(fields).reduce((sum, field) => sum+field.byteLength, 0);
    this.metrics.totalLoadMs += performance.now()-start;
    return { i0, j0, rows, cols, fields };
  }
}

export function decodeTerrainTile(buffer) {
  const bytes=new Uint8Array(buffer), view=new DataView(buffer);
  if(buffer.byteLength<8 || String.fromCharCode(...bytes.subarray(0,4))!=='BHT1') throw new Error('Invalid terrain tile encoding.');
  const length=view.getUint32(4,true), offset=8+length;
  if(offset>buffer.byteLength || offset%4) throw new Error('Invalid terrain tile header.');
  const metadata=JSON.parse(new TextDecoder().decode(bytes.subarray(8,offset)));
  const count=metadata.rows*metadata.cols;
  if(!Number.isInteger(count) || count<1 || count>131**2 || !Array.isArray(metadata.fields)
    || offset+count*4*metadata.fields.length!==buffer.byteLength) throw new Error('Incomplete terrain tile.');
  const fields={};
  metadata.fields.forEach((name,index)=> { fields[name]=new Float32Array(buffer,offset+index*count*4,count); });
  if(!fields.height?.every(Number.isFinite)) throw new Error('Tile contains missing elevations.');
  return { ...metadata, fields, rowIndices:metadata.row_indices,columnIndices:metadata.column_indices,
    byteLength:buffer.byteLength };
}

// The cache owns CPU buffers only. Geometry belongs to the visualization and
// is disposed there. Requests are shared by consumers, with independent abort
// signals; the underlying request is cancelled when its last consumer leaves.
export class RemoteTileSource {
  constructor(descriptor, { fetchImpl=globalThis.fetch, maxTiles=64,maxBytes=32*1024*1024,concurrency=4,retries=2 } = {}) {
    this.descriptor=descriptor;this.fetchImpl=fetchImpl.bind(globalThis);
    this.maxTiles=maxTiles;this.maxBytes=maxBytes;this.concurrency=concurrency;this.retries=retries;
    this.cache=new Map();this.inFlight=new Map();this.errors=new Map();this.queue=[];this.active=0;
    this.metrics={reads:0,bytes:0,totalLoadMs:0,hits:0,cacheHits:0,deduplicatedRequests:0,misses:0,evicted:0,cancelled:0,retries:0,cacheBytes:0};
    this.limitation=descriptor.limitation;
  }
  get keyPrefix() { return this.descriptor.id; }
  key(level,x,y) { return `${level}/${x}/${y}`; }
  readTile(tile,options={}) { return this.getTile(tile.level ?? Math.log2(tile.step||1),tile.x,tile.y,options); }
  getTile(level,x,y,{signal}={}) {
    signal?.throwIfAborted();
    const key=this.key(level,x,y);
    if(this.cache.has(key)) {
      const value=this.cache.get(key);this.cache.delete(key);this.cache.set(key,value);this.metrics.hits++;this.metrics.cacheHits++;
      return Promise.resolve(value);
    }
    let job=this.inFlight.get(key);
    if(!job) {
      this.metrics.misses++;
      job={key,level,x,y,controller:new AbortController(),consumers:new Set(),started:false};
      this.inFlight.set(key,job);this.queue.push(job);
    } else {this.metrics.hits++;this.metrics.deduplicatedRequests++;}
    return new Promise((resolve,reject)=> {
      const consumer={resolve,reject,signal,abort:null};
      consumer.abort=()=> {
        job.consumers.delete(consumer);signal?.removeEventListener('abort',consumer.abort);
        reject(signal?.reason ?? new DOMException('Tile request cancelled','AbortError'));
        if(!job.consumers.size)this.cancel(job);
      };
      job.consumers.add(consumer);signal?.addEventListener('abort',consumer.abort,{once:true});
      this.pump();
    });
  }
  cancel(job) {
    if(job.controller.signal.aborted)return;
    job.controller.abort();this.metrics.cancelled++;
    this.inFlight.delete(job.key);this.queue=this.queue.filter(value=>value!==job);
    for(const c of job.consumers) { c.signal?.removeEventListener('abort',c.abort);c.reject(new DOMException('Obsolete tile request','AbortError')); }
    job.consumers.clear();
  }
  cancelExcept(keys) {
    for(const job of this.inFlight.values())if(!keys.has(job.key))this.cancel(job);
  }
  pump() {
    while(this.active<this.concurrency && this.queue.length) {
      const job=this.queue.shift();if(job.controller.signal.aborted)continue;
      this.active++;job.started=true;
      this.load(job).then(value=> {
        if(job.controller.signal.aborted)return;
        this.errors.delete(job.key);this.cache.set(job.key,value);this.metrics.cacheBytes+=value.byteLength;
        this.trim();return value;
      }).catch(error=> {
        if(!job.controller.signal.aborted) { this.errors.set(job.key,error.message);while(this.errors.size>this.maxTiles)this.errors.delete(this.errors.keys().next().value); }
        throw error;
      }).finally(()=> {
        for(const c of job.consumers)c.signal?.removeEventListener('abort',c.abort);
        if(this.inFlight.get(job.key)===job)this.inFlight.delete(job.key);
        this.active--;this.pump();
      }).then(value=> {for(const c of job.consumers)c.resolve(value);job.consumers.clear();},
        error=> {for(const c of job.consumers)c.reject(error);job.consumers.clear();});
    }
  }
  async load(job) {
    const started=performance.now();
    const url=this.descriptor.tile_url.replace('{level}',job.level).replace('{x}',job.x).replace('{y}',job.y);
    let lastError;
    for(let attempt=0;attempt<=this.retries;attempt++) {
      job.controller.signal.throwIfAborted();
      try {
        const signal=AbortSignal.any([job.controller.signal,AbortSignal.timeout(60000)]);
        const response=await this.fetchImpl(url,{signal,cache:'no-store'});
        if(!response.ok) {
          const error=new Error(`Terrain tile ${job.key}: HTTP ${response.status}`);
          error.retryable=response.status===429 || response.status>=500;throw error;
        }
        const buffer=await response.arrayBuffer();job.controller.signal.throwIfAborted();
        this.metrics.bytes+=buffer.byteLength;
        const tile=decodeTerrainTile(buffer);
        if(tile.tile_id!==job.key || tile.dataset.id!==this.descriptor.id)throw new Error('Tile identity does not match the request.');
        this.metrics.reads++;this.metrics.totalLoadMs+=performance.now()-started;
        tile.requestMs=performance.now()-started;return tile;
      } catch(error) {
        if(job.controller.signal.aborted)throw error;
        lastError=error;if(error.retryable===false || attempt===this.retries)break;
        this.metrics.retries++;
        await new Promise((resolve,reject)=> {
          const abort=()=> {clearTimeout(timer);reject(job.controller.signal.reason);};
          const timer=setTimeout(()=> {job.controller.signal.removeEventListener('abort',abort);resolve();},150*2**attempt);
          job.controller.signal.addEventListener('abort',abort,{once:true});
        });
      }
    }
    throw lastError;
  }
  trim() {
    while(this.cache.size>this.maxTiles || this.metrics.cacheBytes>this.maxBytes) {
      const key=this.cache.keys().next().value,entry=this.cache.get(key);
      this.metrics.cacheBytes-=entry.byteLength;this.cache.delete(key);this.metrics.evicted++;
    }
  }
  sample(field,i,j) {
    // Use the finest resident tile covering the point; camera clearance uses
    // dataset-wide extrema when there is no resident elevation at this point.
    const tiles=Array.from(this.cache.values()).sort((a,b)=>a.level-b.level);
    for(const tile of tiles)if(i>=tile.i0 && i<=tile.i1 && j>=tile.j0 && j<=tile.j1) {
      return windowValue(tile,field,i,j);
    }
    return null;
  }
  async inspect(i,j,{signal}={}) {
    const response=await this.fetchImpl(`${this.descriptor.point_url}?i=${i}&j=${j}`,{signal:AbortSignal.any([signal ?? new AbortController().signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw new Error(`Point inspection: HTTP ${response.status}`);
    return response.json();
  }
  get statistics() {
    return {...this.metrics,cachedTiles:this.cache.size,inFlightTiles:this.inFlight.size,
      errorTiles:Object.fromEntries(this.errors),averageRequestMs:this.metrics.reads ? this.metrics.totalLoadMs/this.metrics.reads : null,
      logicalDimensions:[this.descriptor.size,this.descriptor.size],residentBufferBytes:this.metrics.cacheBytes};
  }
  dispose() {
    for(const job of this.inFlight.values())this.cancel(job);
    this.cache.clear();this.metrics.cacheBytes=0;this.errors.clear();
  }
}

export function windowValue(window, field, i, j) {
  if(window.rowIndices) {
    const nearest=(values,n)=> {
      let low=0,high=values.length-1;
      while(low<high) {const mid=(low+high)>>1;if(values[mid]<n)low=mid+1;else high=mid;}
      return low>0 && Math.abs(values[low-1]-n)<Math.abs(values[low]-n) ? low-1 : low;
    };
    return window.fields[field]?.[nearest(window.rowIndices,i)*window.cols+nearest(window.columnIndices,j)];
  }
  return window.fields[field]?.[(i-window.i0)*window.cols+j-window.j0];
}
