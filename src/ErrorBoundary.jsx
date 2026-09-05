import React from 'react';

// A minimal error boundary — surfaces a readable message instead of a blank
// page while this is still being developed.
export default class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Eskimo Studio crashed:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: '#a3312a' }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>
            Something broke: {String((this.state.error && this.state.error.message) || this.state.error)}
          </div>
          {this.state.error && this.state.error.stack}
        </div>
      );
    }
    return this.props.children;
  }
}
