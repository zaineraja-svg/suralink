import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// A crash anywhere in the tree previously left the user staring at
// a blank white page with no way back except a reload — and before
// persistence existed, that reload could also cost them their
// progress. Persistence now covers that second part; this covers
// the first: a plain-language fallback with a way out, instead of
// nothing.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error('Uncaught error in app tree:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0f1320', color: '#f2ede2', fontFamily: 'system-ui, sans-serif',
          textAlign: 'center', padding: 24,
        }}>
          <div style={{ maxWidth: 340 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🌙</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Something went wrong</div>
            <div style={{ fontSize: 14, color: '#a8a196', lineHeight: 1.5, marginBottom: 20 }}>
              This screen hit an unexpected error. Your progress is saved, so reloading is safe.
            </div>
            <button
              onClick={() => window.location.reload()}
              style={{
                fontSize: 14, fontWeight: 600, padding: '12px 24px', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, #C9A45C, #B5893F)', color: '#1A1305', cursor: 'pointer',
              }}
            >Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
