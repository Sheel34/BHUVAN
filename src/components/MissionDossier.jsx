import React from 'react';
import { MISSION_TYPE_STYLE } from '../lib/lunarMissions';

const STATUS_LABEL = {
  success: 'Success',
  partial: 'Partial success',
  failed: 'Failed',
};

/**
 * Rich mission dossier — opens when a globe marker is clicked. Tells the
 * story of a real lunar surface mission: who, where, when, what they
 * found, how, and the controversies. If the site has analyzable terrain,
 * offers to run the survey workspace there.
 */
export default function MissionDossier({ mission, onClose, onSurvey }) {
  if (!mission) return null;
  const style = MISSION_TYPE_STYLE[mission.type] || MISSION_TYPE_STYLE.lander;

  return (
    <aside className="dossier" onClick={(e) => e.stopPropagation()}>
      <header className="dossier-head">
        <div className="dossier-eyebrow">
          <span className="dossier-type-dot" style={{ background: style.color }} />
          {style.label} · {mission.agency}
        </div>
        <button className="dossier-close" onClick={onClose} title="Close">✕</button>
      </header>

      <h2 className="dossier-title">{mission.mission}</h2>
      <div className="dossier-site">{mission.site}</div>

      <div className="dossier-facts-grid">
        <div><span>Country</span><b>{mission.country}</b></div>
        <div><span>Date</span><b>{mission.date}</b></div>
        <div><span>Transit</span><b>{mission.transit}</b></div>
        <div><span>Status</span><b className={`dossier-status ${mission.status}`}>{STATUS_LABEL[mission.status]}</b></div>
        <div className="dossier-facts-wide"><span>Crew / craft</span><b>{mission.crew}</b></div>
        <div className="dossier-facts-wide"><span>Location</span><b>{mission.lat.toFixed(2)}°, {mission.lon.toFixed(2)}°</b></div>
      </div>

      <p className="dossier-summary">{mission.summary}</p>

      <section className="dossier-section">
        <h3>Discoveries</h3>
        <ul>{mission.discoveries.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </section>

      <section className="dossier-section">
        <h3>How it was done</h3>
        <p>{mission.how}</p>
      </section>

      {mission.facts?.length > 0 && (
        <section className="dossier-section">
          <h3>Notable</h3>
          <ul>{mission.facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </section>
      )}

      {mission.controversy && (
        <section className="dossier-section dossier-controversy">
          <h3>Controversy</h3>
          <p>{mission.controversy}</p>
        </section>
      )}

      {mission.sampleId && (
        <button className="dossier-survey-btn" onClick={() => onSurvey(mission)}>
          RUN TERRAIN SURVEY AT THIS SITE →
        </button>
      )}
    </aside>
  );
}
