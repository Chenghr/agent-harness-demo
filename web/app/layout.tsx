import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harness · 工作空间",
  description:
    "本地 Agent Harness 教学演示：用户打断、后台任务、按需能力加载、上下文压缩与模型交接。",
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
