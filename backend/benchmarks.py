"""Development-only validation and resolution experiments.

python backend/benchmarks.py [projected-dem.tif] [--elevation-noise 0.05]
The default is one SYNTHETIC controlled region at 5 m/sample, not lunar data.
"""
import argparse
import json
import numpy as np
from pipeline.ingest import ingest_geotiff
from pipeline.validation import validation_report, resolution_sensitivity, elevation_perturbation_sensitivity


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('dem',nargs='?')
    parser.add_argument('--elevation-noise',type=float,default=None,help='Explicit assumed elevation sigma in metres; not measured source uncertainty')
    args=parser.parse_args()
    if args.dem:
        grid,metadata=ingest_geotiff(args.dem,target_size=1025)
        elevation=grid.astype(np.float64)*metadata['height_scale_m']+metadata.get('height_min_m',0.)
        spacing=metadata['resolution_m_per_px']
        source={**metadata,'status':'MEASURED','reference_label':'highest-resolution available reference'}
    else:
        spacing=5.;axis=np.arange(257)*spacing;x,y=np.meshgrid(axis,axis)
        elevation=6*np.sin(x*.02)+3*np.cos(y*.01)+3*np.exp(-((x-400)**2+(y-600)**2)/10000)
        source={'status':'SYNTHETIC','dataset_id':'controlled-sinusoidal-region','source_gsd_m':spacing,'body':'unknown'}
    output={'analytical_validation':validation_report(),
            'resolution_sensitivity':resolution_sensitivity(elevation,spacing,source)}
    if args.elevation_noise is not None:
        output['assumed_elevation_perturbation']=elevation_perturbation_sensitivity(elevation,spacing,args.elevation_noise)
    print(json.dumps(output,indent=2,allow_nan=False))


if __name__=='__main__':main()
