import React from 'react';
import { createRoot } from 'react-dom/client';
import '../studio.css';
import App from './App.jsx';

const boot = window.__STUDIO__ || {};
createRoot(document.getElementById('root')).render(<App boot={boot} />);
