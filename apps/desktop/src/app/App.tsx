import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import { Bootstrap, RequireOnboarded } from './Bootstrap';
import { AppShell } from './AppShell';
import { OnboardingPage } from '../features/onboarding/OnboardingPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { ProjectLayout } from '../features/project/ProjectLayout';
import { OverviewPage } from '../features/project/OverviewPage';
import { HistoryPage } from '../features/history/HistoryPage';
import { ConflictsPage } from '../features/conflicts/ConflictsPage';
import { ConflictResolverPage } from '../features/conflicts/ConflictResolverPage';
import { NotesPage } from '../features/notes/NotesPage';
import { MembersPage } from '../features/members/MembersPage';
import { ActivityPage } from '../features/activity/ActivityPage';
import { ProjectSettingsPage } from '../features/settings/ProjectSettingsPage';
import { AppSettingsPage } from '../features/settings/AppSettingsPage';
import { ToastViewport } from '../ui';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
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
      </HashRouter>
    </QueryClientProvider>
  );
}
