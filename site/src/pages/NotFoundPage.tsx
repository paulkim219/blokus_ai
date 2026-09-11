import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';

export function NotFoundPage() {
  usePageTitle('Not found · Art of Blokus');
  return (
    <header className="hero">
      <p className="kicker">404</p>
      <h1>This page is not a Hanni.</h1>
      <p>
        <Link to="/">Return to Art of Blokus</Link>
      </p>
    </header>
  );
}
