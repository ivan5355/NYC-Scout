import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Scout from './pages/Scout';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Scout />} />
        <Route path="/scout" element={<Scout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;