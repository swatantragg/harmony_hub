import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';

import { Shell } from './components/Shell';
import { PwaDock } from './components/PwaDock';
import { ToastHost } from './components/ui';
import { useSession } from './app/session';
import { initPwa } from './app/pwa';
import { applyStoredThemeEarly, useTheme } from './app/theme';
import { Login } from './features/auth/Login';
import { SetPassword } from './features/auth/SetPassword';
import { Profile } from './features/auth/Profile';
import { Dashboard } from './features/home/Dashboard';
import { ArtistDetail, ArtistList } from './features/artists/Artists';
import { SongDetailPage, SongList } from './features/songs/Songs';
import { FolderDetail, FolderList } from './features/folders/Folders';
import { UploadCenter } from './features/upload/UploadCenter';
import { ShareManager } from './features/shares/ShareManager';
import { PublicShare } from './features/share/PublicShare';
import { StorageHealth } from './features/admin/StorageHealth';
import { Dedupe } from './features/dedupe/Dedupe';
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
  if (user.mustChangePassword) return <Navigate to="/set-password" replace />;
  return <>{children}</>;
}

function RequirePendingPassword({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return <BootSplash />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.mustChangePassword) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RequirePermission({ permission, children }: { permission: string; children: React.ReactNode }) {
  const can = useSession((s) => s.can);
  if (!can(permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function BootSplash() {
  return (
    <div className="plain-page" style={{ display: 'grid', placeItems: 'center' }}>
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
      <Route path="/set-password" element={<RequirePendingPassword><SetPassword /></RequirePendingPassword>} />
      <Route path="/s/:token" element={<PublicShare />} />

      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="search" element={<Navigate to="/" replace />} />
        <Route path="artists" element={<ArtistList />} />
        <Route path="artists/:id" element={<ArtistDetail />} />
        <Route path="songs" element={<SongList />} />
        <Route path="songs/:id" element={<SongDetailPage />} />
        <Route path="folders" element={<FolderList />} />
        <Route path="folders/:id" element={<FolderDetail />} />
        {/* Retired in SK-V4.7.0. Kept as a redirect so bookmarks, pinned
            tabs and an installed PWA's history land on Home rather than on a
            blank screen. */}
        <Route path="master-log" element={<Navigate to="/" replace />} />
        <Route path="dedupe" element={<Dedupe />} />
        <Route path="help" element={<Help />} />
        <Route path="profile" element={<Profile />} />
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

applyStoredThemeEarly();

initPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ToastHost>
          <App />
          <PwaDock />
        </ToastHost>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
