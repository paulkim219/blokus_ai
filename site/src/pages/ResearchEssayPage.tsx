import { Link, Navigate, useParams } from 'react-router-dom';
import { essayBySlug } from '../data/essays';
import { usePageTitle } from '../hooks/usePageTitle';

export function ResearchEssayPage() {
  const { slug } = useParams();
  const essay = essayBySlug(slug);
  usePageTitle(essay ? `${essay.title} · Art of Blokus` : 'Art of Blokus');

  if (!essay) {
    return <Navigate to="/research" replace />;
  }

  return (
    <article className="essay">
      <p className="kicker">{essay.kicker}</p>
      <h1>{essay.title}</h1>
      <p className="lede">{essay.lede}</p>
      {essay.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 48)}>{paragraph}</p>
          ))}
          {section.list ? (
            <ul className="prose-list">
              {section.list.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <p>
        <Link to="/research">All research</Link>
      </p>
    </article>
  );
}
