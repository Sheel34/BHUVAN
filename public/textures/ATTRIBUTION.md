# Earth presentation maps

Earth day, ocean specular and normal maps: Solar System Scope / INOVE,
https://www.solarsystemscope.com/textures/ — CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/).

Specular/normal TIFF downloads were losslessly encoded as PNG without pixel edits.
These are adjusted global presentation maps based on NASA imagery, not DEMs,
contemporaneous weather, analytical land cover or a source of metric elevation.
The normal map changes visual shading only. Static cloud and night-light
presentation maps are bundled and attributed below.

## Added globe imagery

`earth-blue-marble-5400.jpg`: NASA Earth Observatory Blue Marble Next
Generation, July 2004 composite, 5400 × 2700. Downloaded unchanged from:
https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x5400x2700.jpg
Source: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/

`2k_earth_clouds.jpg` and `2k_earth_nightmap.jpg`: Solar System Scope / INOVE,
CC BY 4.0, downloaded unchanged from the texture pack linked above. These
are presentation composites, not contemporaneous observations. The cloud
map has no analytical weather role; night lights have no infrastructure role.

The globe uses an accelerated Kepler orbit with NASA mean lunar eccentricity
0.0549, inclination 5.145 degrees and sidereal period 27.32166 days. Display
distance is compressed and phase is arbitrary, not a current ephemeris:
https://ntrs.nasa.gov/api/citations/20090028006/downloads/20090028006.pdf

## Regional lunar terrain

`data_cache/moon/nasa-pgda-site04-5m.tif`: unchanged NASA PGDA
`Site04_final_adj_5mpp_surf.tif`, 3200 × 3200, 5 m pixels, surface-interpolated
LOLA heights in metres in the source MOON_ME / DE421 polar stereographic
frame. Original: https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site04/Site04_final_adj_5mpp_surf.tif
Documentation and uncertainty discussion: https://pgda.gsfc.nasa.gov/products/78
Product README: https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README
This analytical raster is separate from the globe's visual displacement texture.
Pixel spacing is not a claim about effective resolution, accuracy or rock detection.
