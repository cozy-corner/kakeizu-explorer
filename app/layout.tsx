import type { Metadata } from "next";
import { Shippori_Mincho, Noto_Serif_JP } from "next/font/google";
import { washiGround } from "@/components/washiGround";
import "./globals.css";

// Japanese fonts have no `latin`-only subset covering their glyphs, so next/font
// can't preload them without pulling the whole face — disable preload instead.
// Shippori Mincho isn't a variable font, so its weights must be enumerated.
const shipporiMincho = Shippori_Mincho({
  variable: "--font-mincho-display",
  weight: ["500", "600", "700"],
  preload: false,
});

const notoSerifJp = Noto_Serif_JP({
  variable: "--font-mincho-body",
  weight: ["400", "500", "700"],
  preload: false,
});

export const metadata: Metadata = {
  title: "kakeizu-explorer",
  description: "日本の歴史上の人物の家系を、人物から人物へ渡り歩いて探索する",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${shipporiMincho.variable} ${notoSerifJp.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col" style={washiGround}>
        {children}
      </body>
    </html>
  );
}
