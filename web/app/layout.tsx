import type { Metadata } from 'next';
import './globals.css';
import './refined.css';

export const metadata: Metadata = {
  title: '艺工作 · AI 工作空间',
  description: '艺工作：AI 多干活，我们少干活，让工作更简单。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
