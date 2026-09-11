export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="2" fill="#2f79d7" />
      <rect x="14" y="2" width="12" height="12" rx="2" fill="#8b3fd1" />
      <rect x="14" y="14" width="12" height="12" rx="2" fill="#3ec58d" />
      <rect x="26" y="14" width="4" height="12" rx="1.2" fill="#e3a318" />
    </svg>
  );
}
