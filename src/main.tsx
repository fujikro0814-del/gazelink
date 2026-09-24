import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import 'uplot/dist/uPlot.min.css';
import './styles.css';

// No StrictMode: the session owns timers and a network connection whose lifetime is the page's.
createRoot(document.getElementById('root')!).render(<App />);
