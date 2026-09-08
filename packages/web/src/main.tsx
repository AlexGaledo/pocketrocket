import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import { connectWs } from './lib/ws';
import './index.css';

connectWs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
