import React from 'react';

/**
 * Guards the WebGL scenes. A single throw inside the react-three-fiber tree
 * (e.g. a bad GPU probe, a shader/driver quirk) would otherwise unmount the
 * whole canvas and leave a black screen with no hint. This catches it and
 * shows a readable fallback instead.
 */
export default class SceneErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Scene crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="scene-error">
          <div className="scene-error-title">3D VIEW UNAVAILABLE</div>
          <div className="scene-error-msg">{String(this.state.error.message || this.state.error)}</div>
          <button className="scene-error-btn" onClick={() => window.location.reload()}>
            RELOAD
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
