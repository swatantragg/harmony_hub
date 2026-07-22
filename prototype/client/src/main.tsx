import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

import { Shell } from './components/Shell';
import { ToastHost } from './components/ui';
import { useSession } from './app/session';
import { applyStoredThemeEarly, useTheme } from './app/theme';
import { Login } from './features/auth/Login';
import { Dashboard } from './features/home/Dashboard';
import { SearchPage } from './features/search/SearchPage';
import { ArtistDetail, ArtistList } from './features/artists/Artists';
import { SongDetailPage, SongList } from './features/songs/Songs';
import { FolderDetail, FolderList } from './features/folders/Folders';
import { UploadCenter } from './features/upload/UploadCenter';
import { ShareManager } from './features/shares/ShareManager';
import { PublicShare } from './features/share/PublicShare';
import { StorageHealth } from './features/admin/StorageHealth';
import { ActivityLog } from './features/admin/ActivityLog';
import { Users } from './features/admin/Users';
import { Help } from './features/help/Help';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) return <BootSplash />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// Gate a route on a permission rather than a role, so the check matches the server's.
function RequirePermission({ permission, children }: { permission: string; children: React.ReactNode }) {
  const can = useSession((s) => s.can);
  if (!can(permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function BootSplash() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <div className="col" style={{ alignItems: 'center', gap: 14 }}>
        <div className="tile lg"><span className="b1" /><span className="b2" /><span className="b3 spark" /><span className="b4" /><span className="b5" /></div>
        <span className="t-small">Loading your library…</span>
      </div>
    </div>
  );
}

function App() {
  const bootstrap = useSession((s) => s.bootstrap);
  const initTheme = useTheme((s) => s.init);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => initTheme(), [initTheme]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/s/:token" element={<PublicShare />} />

      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="artists" element={<ArtistList />} />
        <Route path="artists/:id" element={<ArtistDetail />} />
        <Route path="songs" element={<SongList />} />
        <Route path="songs/:id" element={<SongDetailPage />} />
        <Route path="folders" element={<FolderList />} />
        <Route path="folders/:id" element={<FolderDetail />} />
        <Route path="help" element={<Help />} />
        <Route path="upload" element={<RequirePermission permission="asset:upload"><UploadCenter /></RequirePermission>} />
        <Route path="shares" element={<RequirePermission permission="share:create"><ShareManager /></RequirePermission>} />
        <Route path="admin/storage" element={<RequirePermission permission="admin:storage"><StorageHealth /></RequirePermission>} />
        <Route path="admin/activity" element={<RequirePermission permission="admin:activity"><ActivityLog /></RequirePermission>} />
        <Route path="admin/users" element={<RequirePermission permission="admin:users"><Users /></RequirePermission>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// Before the first paint, so a dark-theme reload never flashes light.
applyStoredThemeEarly();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ToastHost>
          <App />
        </ToastHost>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
