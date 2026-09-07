import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import VideoPage from './pages/VideoPage';
import ProfilePage from './pages/ProfilePage';
import WizEntryPage from './pages/WizEntryPage';
import Layout from './components/layout/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import HelpPage from './pages/HelpPage';

const WizWorkspacePage = lazy(() => import('./pages/WizWorkspacePage'));

function App() {
  return (
    <Routes>
      <Route
        path="/*"
        element={<Layout><Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/wiz" element={<WizEntryPage />} />
          <Route path="/wiz/*" element={<Suspense fallback={<div role="status" className="p-8 text-center text-muted-foreground">Loading Wiz...</div>}><WizWorkspacePage /></Suspense>} />
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
          <Route path="/dashboard/:videoId" element={<ProtectedRoute><VideoPage /></ProtectedRoute>} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />
          <Route path="/help" element={<HelpPage />} />
        </Routes></Layout>}
      />
    </Routes>
  );
}

export default App;

