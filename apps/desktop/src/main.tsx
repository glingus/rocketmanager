import './theme/global.css';
import { startApp } from './app/startup/startApp';

// The app (and with it the backend and data layer, which use top-level await) is imported
// dynamically: if starting fails, startApp shows a readable error screen instead of a blank window.
void startApp(document.getElementById('root')!, { loadApp: () => import('./app/App') });
