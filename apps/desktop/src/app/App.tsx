import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { Bootstrap, RequireOnboarded } from './Bootstrap';
import { AppShell } from './AppShell';
import { Spinner, ToastViewport } from '../ui';

const OnboardingPage = lazy(() => import('../features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })));
const DashboardPage = lazy(() => import('../features/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const ProjectLayout = lazy(() => import('../features/project/ProjectLayout').then((m) => ({ default: m.ProjectLayout })));
const OverviewPage = lazy(() => import('../features/project/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const HistoryPage = lazy(() => import('../features/history/HistoryPage').then((m) => ({ default: m.HistoryPage })));
const ConflictsPage = lazy(() => import('../features/conflicts/ConflictsPage').then((m) => ({ default: m.ConflictsPage })));
const ConflictResolverPage = lazy(() => import('../features/conflicts/ConflictResolverPage').then((m) => ({ default: m.ConflictResolverPage })));
const NotesPage = lazy(() => import('../features/notes/NotesPage').then((m) => ({ default: m.NotesPage })));
const MembersPage = lazy(() => import('../features/members/MembersPage').then((m) => ({ default: m.MembersPage })));
const ActivityPage = lazy(() => import('../features/activity/ActivityPage').then((m) => ({ default: m.ActivityPage })));
const ProjectSettingsPage = lazy(() => import('../features/settings/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })));
const AppSettingsPage = lazy(() => import('../features/settings/AppSettingsPage').then((m) => ({ default: m.AppSettingsPage })));

function RouteFallback() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: 160, color: 'var(--ink-600)' }}>
      <Spinner size={24} label="Caricamento" />
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route element={<Bootstrap />}>
            <Route path="/onboarding" element={<><OnboardingPage /><ToastViewport /></>} />
            <Route element={<RequireOnboarded />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="settings" element={<AppSettingsPage />} />
                <Route path="p/:projectId" element={<ProjectLayout />}>
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<OverviewPage />} />
                  <Route path="history" element={<HistoryPage />} />
                  <Route path="conflicts" element={<ConflictsPage />} />
                  <Route path="conflicts/:conflictId" element={<ConflictResolverPage />} />
                  <Route path="notes" element={<NotesPage />} />
                  <Route path="members" element={<MembersPage />} />
                  <Route path="activity" element={<ActivityPage />} />
                  <Route path="settings" element={<ProjectSettingsPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
        </Suspense>
      </HashRouter>
    </QueryClientProvider>
  );
}
