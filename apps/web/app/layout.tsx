import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "EvoKeeper 管理台",
  description: "自进化社区助手：轨迹 / 记忆 / 评测 / 发布",
};

const NAV: Array<[string, string]> = [
  ["/", "概览"],
  ["/evals", "评测报告"],
  ["/traces", "轨迹"],
  ["/golden", "Golden Set"],
  ["/review", "仲裁清单"],
  ["/memory", "记忆"],
  ["/releases", "发布"],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <nav>
          {NAV.map(([href, label]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
          <span className="muted" style={{ marginLeft: "auto" }}>
            EvoKeeper · W7
          </span>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
