import { Outlet } from 'react-router-dom';
import { PLAY_BLOKUS_URL } from '../data/models';
import { Nav } from './Nav';

export function Layout() {
  return (
    <>
      <Nav />
      <main id="main" className="site-main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div>Art of Blokus · Hanni</div>
          <a href={PLAY_BLOKUS_URL} rel="noreferrer">
            Play four-player Blokus on Blokee
          </a>
        </div>
      </footer>
    </>
  );
}
