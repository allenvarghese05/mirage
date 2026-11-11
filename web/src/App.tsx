import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Home } from './pages/Home';
import { StorePage } from './pages/StorePage';
import { OrderStatusPage } from './pages/OrderStatusPage';
import { Dashboard } from './pages/Dashboard';
import { Demo } from './pages/Demo';

// AG Grid is large; only the scoreboard needs it.
const Scoreboard = lazy(() => import('./pages/Scoreboard').then((m) => ({ default: m.Scoreboard })));

export function App() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/store/:storeId" element={<StorePage />} />
      <Route path="/store/:storeId/order/:orderId" element={<OrderStatusPage />} />
      <Route path="/order/return" element={<OrderStatusPage />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/scoreboard" element={<Suspense fallback={<div className="console" />}><Scoreboard /></Suspense>} />
      <Route path="/demo" element={<Demo />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ErrorBoundary>
  );
}
