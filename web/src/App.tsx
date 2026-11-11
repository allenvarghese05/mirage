import { Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './pages/Home';
import { StorePage } from './pages/StorePage';
import { OrderStatusPage } from './pages/OrderStatusPage';
import { Dashboard } from './pages/Dashboard';
import { Scoreboard } from './pages/Scoreboard';
import { Demo } from './pages/Demo';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/store/:storeId" element={<StorePage />} />
      <Route path="/store/:storeId/order/:orderId" element={<OrderStatusPage />} />
      <Route path="/order/return" element={<OrderStatusPage />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/scoreboard" element={<Scoreboard />} />
      <Route path="/demo" element={<Demo />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
