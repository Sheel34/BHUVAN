import numpy as np
import pytest
from data.height_rgb import encode_height_rgb,decode_height_rgb

def test_quantization_roundtrip_bounds_and_negative_absolute_elevations():
    rng=np.random.default_rng(83)
    heights=rng.uniform(-9000,12000,(64,64));heights[0,:3]=[-10000,0,1667721.5]
    decoded=decode_height_rgb(encode_height_rgb(heights))
    assert np.max(np.abs(decoded-heights))<=.050000001
    assert decoded[0,0]==-10000 and decoded[0,1]==0

@pytest.mark.parametrize('value',[np.nan,np.inf,-10000.1,1667721.6])
def test_unknown_or_unrepresentable_values_are_not_clipped_into_valid_terrain(value):
    with pytest.raises(ValueError):encode_height_rgb([[value]])
