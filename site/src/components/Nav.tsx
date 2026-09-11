import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { GENERATION_NAV, PLAY_BLOKUS_URL, type GenerationId } from '../data/models';
import { Mark } from './Mark';

export function Nav() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [hanniOpen, setHanniOpen] = useState(false);
  const [activeGen, setActiveGen] = useState<GenerationId | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const menuId = useId();

  useEffect(() => {
    setMenuOpen(false);
    setHanniOpen(false);
    setActiveGen(null);
  }, [location.pathname]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setHanniOpen(false);
        setActiveGen(null);
        setMenuOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function clearClose() {
    window.clearTimeout(closeTimer.current);
  }

  function scheduleClose() {
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      setHanniOpen(false);
      setActiveGen(null);
    }, 140);
  }

  const active = GENERATION_NAV.find((gen) => gen.id === activeGen);
  const variants = active?.variants ?? [];

  return (
    <header className={menuOpen ? 'site-header open' : 'site-header'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="site-header-inner">
        <Link className="wordmark" to="/">
          <Mark className="mark" />
          Art of Blokus
        </Link>
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          Menu
        </button>
        <nav id={menuId} className="header-nav" aria-label="Primary">
          <div
            className="hanni-menu"
            onMouseEnter={() => {
              clearClose();
              setHanniOpen(true);
              setActiveGen((current) => current ?? '4.1');
            }}
            onMouseLeave={scheduleClose}
          >
            <button
              type="button"
              className={hanniOpen ? 'nav-link open' : 'nav-link'}
              aria-expanded={hanniOpen}
              aria-haspopup="true"
              onClick={() => {
                setHanniOpen((open) => !open);
                if (!hanniOpen) setActiveGen('4.1');
              }}
            >
              Hanni
            </button>
            {hanniOpen ? (
              <div className="hanni-flyout" role="menu">
                <ul className="hanni-generations">
                  {GENERATION_NAV.map((gen) => {
                    const hasVariants = Boolean(gen.variants?.length);
                    const className =
                      activeGen === gen.id || location.pathname === gen.href ? 'open' : '';
                    if (gen.href && !hasVariants) {
                      return (
                        <li key={gen.id}>
                          <Link
                            to={gen.href}
                            className={className}
                            onMouseEnter={() => setActiveGen(gen.id)}
                          >
                            {gen.label}
                            {gen.comingSoon ? <span className="soon-chip">Soon</span> : null}
                          </Link>
                        </li>
                      );
                    }
                    return (
                      <li key={gen.id}>
                        <button
                          type="button"
                          className={className ? `gen-btn ${className}` : 'gen-btn'}
                          onMouseEnter={() => setActiveGen(gen.id)}
                          onFocus={() => setActiveGen(gen.id)}
                          onClick={() => setActiveGen(gen.id)}
                        >
                          {gen.label}
                          <span aria-hidden="true">›</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {variants.length > 0 ? (
                  <div className="variant-panel">
                    {variants.map((variant) => (
                      <Link key={variant.id} to={`/models/${variant.id}`}>
                        <span className="name">{variant.label}</span>
                        <span className="role">{variant.role}</span>
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <NavLink className="nav-link" to="/research">
            Research
          </NavLink>
        </nav>
        <div className="header-actions">
          <a className="play-link" href={PLAY_BLOKUS_URL} rel="noreferrer">
            Play Blokus
          </a>
        </div>
      </div>
    </header>
  );
}
