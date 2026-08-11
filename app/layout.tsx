import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pathway Mapper',
  description: 'Turn-by-turn navigation through clinical pathway documents',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
