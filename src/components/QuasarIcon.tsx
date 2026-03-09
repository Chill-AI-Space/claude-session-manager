export function QuasarIcon({ className = "h-4 w-4" }: { className?: string }) {
  // Matches the favicon quasar: 6 curved crescent arms + core with bright dot + stars
  // Simplified SVG version for inline use
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      {/* 6 crescent arms */}
      <path d="M50 43c8-2 18-8 24-14 4 8 0 18-8 22-6-2-12-4-16-8z" />
      <path d="M57 50c2 8 8 18 14 24-8 4-18 0-22-8 2-6 4-12 8-16z" />
      <path d="M50 57c-8 2-18 8-24 14-4-8 0-18 8-22 6 2 12 4 16 8z" />
      <path d="M43 50c-2-8-8-18-14-24 8-4 18 0 22 8-2 6-4 12-8 16z" />
      <path d="M55 44c6-6 15-10 22-10-2 8-8 16-16 18-2-2-4-5-6-8z" />
      <path d="M56 55c6 6 10 15 10 22-8-2-16-8-18-16 2-2 5-4 8-6z" />
      <path d="M45 56c-6 6-15 10-22 10 2-8 8-16 16-18 2 2 4 5 6 8z" />
      <path d="M44 45c-6-6-10-15-10-22 8 2 16 8 18 16-2 2-5 4-8 6z" />
      {/* Core */}
      <circle cx="50" cy="50" r="7" />
      {/* Bright dot */}
      <circle cx="50" cy="50" r="3" opacity="0.3" />
      {/* Stars */}
      <circle cx="18" cy="15" r="1.2" opacity="0.4" />
      <circle cx="82" cy="85" r="1" opacity="0.4" />
      <circle cx="84" cy="20" r="1.2" opacity="0.4" />
      <circle cx="16" cy="82" r="1" opacity="0.4" />
    </svg>
  );
}
