"""Streaming acquisition events reflect work performed, never timed UI milestones."""
import os
import asyncio
import json
import logging
import threading
import time
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, FiniteFloat

from .terrain_providers import Region, acquire_dem, DataUnavailable, SentinelImageryProvider

router=APIRouter(prefix='/api/v1/terrain',tags=['Location terrain'])
logger=logging.getLogger(__name__)
working_sets=threading.BoundedSemaphore(max(1,min(2,int(os.environ.get("BHUVAN_ACQUISITION_SLOTS","1")))))


class LocationRequest(BaseModel):
    body: Literal['earth','moon']
    lat: FiniteFloat=Field(ge=-90,le=90)
    lon: FiniteFloat=Field(ge=-180,le=180)
    region_size_m: FiniteFloat=Field(default=10000,ge=500,le=30000)
    sentinel_imagery: bool=False
    stream_tiles: bool=False  # Additive opt-in; existing clients keep their full-patch response.
    lroc_dataset: str | None = None
    overview: bool = False


@router.post('/acquire')
async def acquire_location(request: LocationRequest):
    async def events():
        loop=asyncio.get_running_loop();queue=asyncio.Queue();cancelled=threading.Event()
        def send(event):
            if cancelled.is_set():
                raise InterruptedError('Acquisition cancelled')
            loop.call_soon_threadsafe(queue.put_nowait,event)
        def work():
            started={}
            def progress(stage,status,detail):
                if status=='started':
                    started[stage]=time.perf_counter()
                event={'type':'stage','stage':stage,'status':status,'detail':detail}
                if status=='completed' and stage in started:
                    event['elapsed_ms']=(time.perf_counter()-started[stage])*1000
                logger.info('Terrain acquisition %s %s: %s',stage,status,detail)
                send(event)
            acquired=working_sets.acquire(blocking=False)
            try:
                if not acquired:
                    raise DataUnavailable('Terrain processing is busy. Wait for the current request to finish, then retry.','ACQUISITION_BUSY')
                from main import build_payload, OUTPUT_DIR
                region=Region(request.body,request.lat,request.lon,request.region_size_m)
                entry=None;provider=None
                if request.lroc_dataset:
                    if request.body!='moon': raise ValueError('LROC products require Moon coordinates.')
                    from .lroc_catalogue import selected_product
                    entry,provider=selected_product(request.lroc_dataset)
                kwargs={}
                if provider: kwargs["provider"]=provider
                if request.overview: kwargs["overview"]=True
                grid,metadata=acquire_dem(region,progress,**kwargs)
                if entry:
                    progress('LROC ORTHOPHOTO','started','Registering observed grayscale imagery to the measured DEM')
                    try:
                        from pipeline.surface_imagery import align_raster_image
                        url,imagery=align_raster_image(entry['ortho'],metadata,OUTPUT_DIR)
                        imagery.update(source='LROC NAC orthophoto',reference=entry['page'])
                        metadata['color_url']=url;metadata['acquisition']['imagery']=imagery
                        metadata['terrain_name']=entry['title']+' · LROC stereo DTM'
                        progress('LROC ORTHOPHOTO','completed',imagery['dataset_id'])
                    except (ValueError,OSError) as exc:
                        metadata['acquisition']['imagery']={'status':'unavailable','reason':str(exc)}
                        progress('LROC ORTHOPHOTO','unavailable',str(exc))
                if request.sentinel_imagery and request.body=='earth':
                    progress('SENTINEL IMAGERY','started','Optional RGB; elevation is already acquired')
                    try:
                        url,imagery=SentinelImageryProvider().acquire(region,metadata,OUTPUT_DIR)
                        metadata['color_url']=url;metadata['acquisition']['imagery']=imagery
                        progress('SENTINEL IMAGERY','completed',imagery['dataset_id'])
                    except (DataUnavailable,OSError) as exc:
                        metadata['acquisition']['imagery']={'status':'unavailable','reason':str(exc)}
                        progress('SENTINEL IMAGERY','unavailable',str(exc))
                progress('ANALYSING','started','Terrain derivatives and heuristic candidate regions')
                payload=build_payload(grid,metadata,progress=lambda detail,_:progress('ANALYSING','working',detail))
                progress('ANALYSING','completed','Analysis and source provenance retained')
                result=payload.model_dump(mode='json')
                if request.stream_tiles:
                    from .terrain_tiles import register_analysis
                    descriptor=register_analysis(payload,metadata)
                    result['terrain_stream']=descriptor
                    result['terrain']['data']=[]
                    result['layers']={name:[] for name in descriptor['fields'] if name!='height'}
                    result['metadata']['provenance']['transport']='binary tiles; original analysis retained server-side'
                send({'type':'result','analysis':result})
            except InterruptedError:
                pass
            except Exception as exc:
                logger.exception('Location acquisition failed')
                if not cancelled.is_set():
                    send({'type':'error','code':getattr(exc,'code','ACQUISITION_FAILED'),'message':str(exc)})
            finally:
                if acquired:
                    working_sets.release()
                loop.call_soon_threadsafe(queue.put_nowait,None)
        task=asyncio.create_task(asyncio.to_thread(work))
        try:
            while True:
                event=await queue.get()
                if event is None:
                    break
                yield json.dumps(event,allow_nan=False,separators=(',',':'))+'\n'
        finally:
            cancelled.set()
            # GDAL reads have bounded timeouts. Don't block the disconnect path on them.
            task.add_done_callback(lambda result: result.exception() if not result.cancelled() else None)
    return StreamingResponse(events(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})
