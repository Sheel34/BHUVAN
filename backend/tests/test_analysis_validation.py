import numpy as np
import pytest
from pipeline.validation import validation_report, resolution_sensitivity, elevation_perturbation_sensitivity


def test_analytical_surface_validation_reports_measured_operator_errors():
    report=validation_report();records=report['records']
    assert len(records)==18
    for row in records:
        assert np.isfinite(row['actual_mean'])
        if row['surface'] in ('flat','known-angle plane','paraboloid'):
            assert row['mean_absolute_error']<1e-4
        if row['surface'] in ('sinusoid','isolated pit'):
            assert row['relative_l2_error']<.015
    flat=next(r for r in records if r['surface']=='flat' and r['metric']=='slope')
    assert flat['relative_l2_error'] is None
    assert 'undefined' in next(r for r in records if r['surface']=='step')['truth']


def test_resolution_sensitivity_uses_same_region_and_records_model_and_gsd():
    axis=np.arange(257,dtype=float)*5.;x,y=np.meshgrid(axis,axis)
    terrain=.1*np.sin(x*.02)+.05*np.cos(y*.01)
    result=resolution_sensitivity(terrain,5.,{'dataset':'one controlled region'})
    assert [r['analysis_gsd_m'] for r in result['records']]==[5,10,20,40,80]
    assert result['extent_m']==1280 and result['source_provenance']['dataset']=='one controlled region'
    assert result['records'][0]['hazard_classification_agreement']==1
    assert result['records'][0]['top_candidate_displacement_m']==0
    for r in result['records']:
        assert r['processing_ms']>0 and r['python_tracked_peak_bytes']>0
        assert 0<=r['hazard_classification_agreement']<=1
        assert r['candidate_region_count']>=1
    with pytest.raises(ValueError):resolution_sensitivity(terrain,5.,requested_gsds=[1])


def test_elevation_noise_recomputes_pipeline_and_is_candidate_specific_not_index_noise():
    terrain=np.zeros((65,65));terrain[:,32:]=100.
    result=elevation_perturbation_sensitivity(terrain,5.,sigma_m=0.,realizations=4)
    assert len(result['records'])==2
    assert result['pipeline_recomputed'][0]=='elevation'
    assert 'not measured' in result['kind']
    for candidate in result['records']:
        assert candidate['mean_hazard_percentiles'][0]==candidate['mean_hazard_percentiles'][2]
        assert candidate['nearby_candidate_fraction']==1.
        assert candidate['fixed_footprint_cells']>1
    noisy=elevation_perturbation_sensitivity(terrain,5.,sigma_m=.05,realizations=4)
    assert any(r['mean_hazard_percentiles'][2]>r['mean_hazard_percentiles'][0] for r in noisy['records'])
