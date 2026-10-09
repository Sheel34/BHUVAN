"""Five verified LROC stereo DTMs with co-registered orthophotos."""
import json
from pathlib import Path
from .terrain_providers import Product, ConfiguredLunarTerrainProvider

def catalogue():
    return json.loads(Path(__file__).with_name('lroc_catalogue.json').read_text(encoding='utf-8'))

def selected_product(dataset_id):
    entry=next((p for p in catalogue() if p['id']==dataset_id),None)
    if not entry: raise ValueError('Choose one of the five curated LROC datasets.')
    product=Product(entry['id'],entry['dtm'],'lroc-nac-dtm','moon',entry['gsd'],
        'Source LROC stereo DTM heights relative to lunar sphere; inspect source label and confidence map',
        'NASA / LRO / LROC / Arizona State University',tuple(entry['bounds']),
        {'reference':entry['page'],'orthophoto':entry['ortho'],'method':'stereophotogrammetry; pixel spacing is not an obstacle detection guarantee'})
    return entry,ConfiguredLunarTerrainProvider([product],use_usgs=False)
