import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Confere Preços",
  description: "Encontre os menores preços nos supermercados da sua cidade.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${inter.variable} antialiased`}>
      <body className="min-h-screen bg-stone-50 text-stone-900 font-sans selection:bg-orange-200 selection:text-orange-900">
        {children}
      </body>
    </html>
  );
}
